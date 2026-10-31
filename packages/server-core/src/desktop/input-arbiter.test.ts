import { describe, expect, test } from 'bun:test'
import { InputArbiter, InputArbiterError } from './input-arbiter'
import type { HumanLease, InputArbiterJournal, InputArbiterOptions } from './input-arbiter'

const scope = { workspaceId: 'workspace-fixture', sessionId: 'session-fixture', connectionId: 'connection-fixture' }
function fixture(overrides: Partial<InputArbiterOptions> = {}) {
  let now = 1000
  let owner = false
  let legacy = false
  let entitled = true
  const records: InputArbiterJournal[] = []
  const arbiter = new InputArbiter({
    initialJournal: { version: 1, dirty: false },
    persistJournal: record => { records.push(record) },
    cooperativeOwnerPresent: () => owner,
    legacyProxyActive: () => legacy,
    authorizeHuman: s => entitled && s.workspaceId === scope.workspaceId && s.sessionId === scope.sessionId && s.connectionId === scope.connectionId,
    now: () => now,
    maxLeaseMs: 100,
    maxContinuousMs: 250,
    ...overrides,
  })
  return { arbiter, records, time: (t: number) => { now = t }, owner: (v: boolean) => { owner = v }, legacy: (v: boolean) => { legacy = v }, entitled: (v: boolean) => { entitled = v } }
}

/** Synthetic callbacks only. No desktop, upstream VNC socket or CUA tool is used. */
describe('InputArbiter synchronous ownership', () => {
  test('takeover-v-agent same-turn contenders: exactly one reservation wins in either order', async () => {
    for (const first of ['agent', 'human'] as const) {
      const { arbiter, records } = fixture()
      const attempts: Array<() => unknown> = first === 'agent'
        ? [() => arbiter.beginAgent('operation'), () => arbiter.acquireHuman(scope, 1100)]
        : [() => arbiter.acquireHuman(scope, 1100), () => arbiter.beginAgent('operation')]
      const results = await Promise.allSettled(attempts.map(fn => Promise.resolve().then(fn)))
      expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected'])
      expect(records).toEqual([{ version: 1, dirty: true }])
      expect(arbiter.state.phase).toBe(first)
    }
  })

  test('admission is not completion; hung reservations never time out or get stolen', () => {
    const f = fixture()
    const reservation = f.arbiter.beginAgent('operation')
    f.time(1_000_000)
    expect(f.arbiter.state.phase).toBe('agent')
    expect(() => f.arbiter.acquireHuman(scope, 1_000_100)).toThrow()
    expect(() => f.arbiter.beginAgent('second-operation')).toThrow()
    expect(() => f.arbiter.finishAgent({ ...reservation }, true)).toThrow()
    expect(f.arbiter.state.phase).toBe('agent')
    f.arbiter.finishAgent(reservation, true)
    expect(f.records.at(-1)).toEqual({ version: 1, dirty: false })
    expect(f.arbiter.state.phase).toBe('idle')
    expect(() => f.arbiter.finishAgent(reservation, true)).toThrow()
  })

  test('uncertain agent completion (timeout, disconnect or crash) is sticky quarantine', () => {
    const f = fixture()
    const reservation = f.arbiter.beginAgent('operation')
    expect(() => f.arbiter.finishAgent(reservation, false)).toThrow(InputArbiterError)
    expect(f.arbiter.state.phase).toBe('quarantine')
    expect(() => f.arbiter.finishAgent(reservation, true)).toThrow()
    expect(() => f.arbiter.acquireHuman(scope, 1100)).toThrow()
    expect(f.records.at(-1)?.dirty).toBe(true)
  })

  test('dirty restart never resets ownership; missing/malformed journal and callbacks deny', () => {
    const f = fixture()
    f.arbiter.beginAgent('operation')
    const restarted = fixture({ initialJournal: f.records.at(-1)! }).arbiter
    expect(restarted.state.phase).toBe('quarantine')
    expect(() => restarted.beginAgent('restart')).toThrow()
    expect(() => restarted.acquireHuman(scope, 1100)).toThrow()
    for (const bad of [undefined, {}, { version: 2, dirty: false }, { version: 1, dirty: 'false' }]) {
      expect(() => fixture({ initialJournal: bad as InputArbiterJournal })).toThrow()
    }
    expect(() => fixture({ legacyProxyActive: undefined })).toThrow()
    expect(() => fixture({ cooperativeOwnerPresent: undefined })).toThrow()
    expect(() => fixture({ persistJournal: undefined })).toThrow()
    expect(() => fixture({ authorizeHuman: undefined })).toThrow()
  })

  test('owner/legacy checks and current scoped entitlement are mandatory', () => {
    for (const gate of ['owner', 'legacy', 'entitled'] as const) {
      const f = fixture()
      f[gate](gate !== 'entitled')
      expect(() => f.arbiter.acquireHuman(scope, 1100)).toThrow()
      expect(f.records).toEqual([])
      if (gate === 'legacy') expect(() => f.arbiter.beginAgent('operation')).toThrow()
    }
    for (const key of ['workspaceId', 'sessionId', 'connectionId']) {
      const f = fixture()
      expect(() => f.arbiter.acquireHuman({ ...scope, [key]: 'foreign' }, 1100)).toThrow()
    }
  })

  test('existing cooperative owner denies takeover but not an owner-authorized brokered agent call', () => {
    const f = fixture(); f.owner(true)
    expect(() => f.arbiter.acquireHuman(scope, 1100)).toThrow()
    const reservation = f.arbiter.beginAgent('owner-authorized-operation')
    expect(f.arbiter.state.phase).toBe('agent')
    expect(() => f.arbiter.acquireHuman(scope, 1100)).toThrow()
    f.arbiter.finishAgent(reservation, true)
    expect(() => f.arbiter.acquireHuman(scope, 1100)).toThrow()
    expect(f.arbiter.state.phase).toBe('idle')
  })

  test('default explicit lease is five minutes and entitlement deadline can shorten it', () => {
    const f = fixture({ maxLeaseMs: undefined, maxContinuousMs: undefined })
    const lease = f.arbiter.acquireHuman(scope, 999_999)
    expect(f.arbiter.state.humanExpiresAt).toBe(301_000)
    f.time(301_000)
    expect(f.arbiter.valid(lease)).toBe(false)
    expect(f.arbiter.state.phase).toBe('releasing')
    const g = fixture({ maxLeaseMs: undefined, maxContinuousMs: undefined })
    g.arbiter.acquireHuman(scope, 5000)
    expect(g.arbiter.state.humanExpiresAt).toBe(5000)
  })

  test('dirty is durably written before lease/reservation admission and actual write', () => {
    let dirty = false
    const f = fixture({ persistJournal: record => { dirty = record.dirty } })
    const lease = f.arbiter.acquireHuman(scope, 1100)
    let written = false
    f.arbiter.writeHuman(lease, () => { expect(dirty).toBe(true); written = true })
    expect(written).toBe(true)
    f.arbiter.beginRelease(lease)
    expect(dirty).toBe(true)
    f.arbiter.finishRelease(lease, true)
    expect(dirty).toBe(false)
    f.arbiter.beginAgent('operation')
    expect(dirty).toBe(true)
  })

  test('journal failure before admission, on clean, or on release quarantines', () => {
    for (const path of ['admit', 'agent-clean', 'human-clean']) {
      let fail = path === 'admit'
      const f = fixture({ persistJournal: () => { if (fail) throw new Error('secret journal path') } })
      if (path === 'admit') expect(() => f.arbiter.beginAgent('operation')).toThrow('quarantined')
      if (path === 'agent-clean') {
        const reservation = f.arbiter.beginAgent('operation'); fail = true
        expect(() => f.arbiter.finishAgent(reservation, true)).toThrow('quarantined')
      }
      if (path === 'human-clean') {
        const lease = f.arbiter.acquireHuman(scope, 1100); f.arbiter.beginRelease(lease); fail = true
        expect(() => f.arbiter.finishRelease(lease, true)).toThrow('quarantined')
      }
      expect(f.arbiter.state.phase).toBe('quarantine')
      expect(() => f.arbiter.beginAgent('operation')).toThrow()
    }
  })

  test('admission becoming denied after write-ahead dirty cannot fall back to idle', () => {
    let owner = false
    const f = fixture({ cooperativeOwnerPresent: () => owner, persistJournal: record => { if (record.dirty) owner = true } })
    expect(() => f.arbiter.acquireHuman(scope, 1100)).toThrow()
    expect(f.arbiter.state.phase).toBe('quarantine')
  })
})

describe('InputArbiter human fencing', () => {
  test('queued write checks revocation at actual write boundary; matching is identity-scoped', () => {
    const f = fixture()
    const lease = f.arbiter.acquireHuman(scope, 1100)
    let writes = 0
    const queued = () => f.arbiter.writeHuman(lease, () => { writes++ })
    f.arbiter.revoke({ ...scope, connectionId: 'foreign' })
    expect(f.arbiter.valid(lease)).toBe(true)
    f.arbiter.revoke(scope)
    expect(() => queued()).toThrow()
    expect(writes).toBe(0)
    expect(f.arbiter.valid(lease)).toBe(false)
    expect(f.arbiter.state.phase).toBe('releasing')
    expect(() => f.arbiter.beginAgent('operation')).toThrow()
    f.arbiter.finishRelease(lease, true)
    expect(f.arbiter.state.phase).toBe('idle')
  })

  test('stale generation, forged copy and cross-instance identity replay cannot write, renew or release', () => {
    const f = fixture()
    const old = f.arbiter.acquireHuman(scope, 1100)
    f.arbiter.beginRelease(old); f.arbiter.finishRelease(old, true)
    const current = f.arbiter.acquireHuman(scope, 1100)
    expect(current.generation).not.toBe(old.generation)
    const other = fixture().arbiter.acquireHuman(scope, 1100)
    for (const replay of [old, other, { ...current } as HumanLease, null as unknown as HumanLease]) {
      expect(f.arbiter.valid(replay)).toBe(false)
      expect(() => f.arbiter.writeHuman(replay, () => { throw new Error('must not write') })).toThrow()
      expect(() => f.arbiter.renewHuman(replay, 1100)).toThrow()
      expect(() => f.arbiter.beginRelease(replay)).toThrow()
      expect(() => f.arbiter.finishRelease(replay, true)).toThrow()
    }
    expect(f.arbiter.valid(current)).toBe(true)
  })

  test('release fences immediately; cleanup confirmation is required and failure quarantines', () => {
    const f = fixture()
    const lease = f.arbiter.acquireHuman(scope, 1100)
    expect(() => f.arbiter.finishRelease(lease, true)).toThrow()
    f.arbiter.beginRelease(lease)
    expect(f.arbiter.valid(lease)).toBe(false)
    expect(() => f.arbiter.writeHuman(lease, () => {})).toThrow()
    expect(() => f.arbiter.acquireHuman(scope, 1100)).toThrow()
    expect(() => f.arbiter.finishRelease(lease, false)).toThrow()
    expect(f.arbiter.state.phase).toBe('quarantine')
    expect(() => f.arbiter.finishRelease(lease, true)).toThrow()
  })

  test('expiry is a fence, not cleanup or implicit release, and cannot be renewed at expiry', () => {
    const f = fixture()
    const lease = f.arbiter.acquireHuman(scope, 5000)
    expect(f.arbiter.state.humanExpiresAt).toBe(1100)
    f.time(1100)
    expect(() => f.arbiter.renewHuman(lease, 1200)).toThrow()
    expect(f.arbiter.valid(lease)).toBe(false)
    expect(f.arbiter.state.phase).toBe('releasing')
    expect(() => f.arbiter.writeHuman(lease, () => {})).toThrow()
    expect(() => f.arbiter.beginAgent('operation')).toThrow()
    f.arbiter.finishRelease(lease, true)
    expect(f.arbiter.state.phase).toBe('idle')
  })

  test('explicit renewal wins before expiry, but never exceeds continuous limit or bypasses entitlement', () => {
    const f = fixture()
    const lease = f.arbiter.acquireHuman(scope, 1100)
    f.time(1099)
    expect(f.arbiter.renewHuman(lease, 9999)).toBe(lease)
    expect(f.arbiter.state.humanExpiresAt).toBe(1199)
    f.time(1198); f.arbiter.renewHuman(lease, 9999)
    expect(f.arbiter.state.humanExpiresAt).toBe(1250)
    f.time(1249); f.arbiter.renewHuman(lease, 9999)
    expect(f.arbiter.state.humanExpiresAt).toBe(1250)
    f.time(1250)
    expect(() => f.arbiter.renewHuman(lease, 9999)).toThrow()
    expect(f.arbiter.state.phase).toBe('releasing')
    const denied = fixture(); const other = denied.arbiter.acquireHuman(scope, 1100)
    denied.entitled(false)
    expect(() => denied.arbiter.renewHuman(other, 1200)).toThrow()
    expect(denied.arbiter.state.phase).toBe('releasing')
  })

  test('expiry during entitlement callback cannot authorize a stale write or renewal', () => {
    let now = 1000
    let expire = false
    const f = fixture({ now: () => now, authorizeHuman: () => { if (expire) now = 1100; return true } })
    const lease = f.arbiter.acquireHuman(scope, 1100)
    expire = true
    let writes = 0
    expect(() => f.arbiter.writeHuman(lease, () => { writes++ })).toThrow()
    expect(() => f.arbiter.renewHuman(lease, 1200)).toThrow()
    expect(writes).toBe(0)
  })

  test('clock ticking at renewal commit boundary still fences expired generation', () => {
    let now = 1000
    let tick = false
    let reads = 0
    const f = fixture({ now: () => tick && ++reads >= 3 ? 1100 : now })
    const lease = f.arbiter.acquireHuman(scope, 1100)
    now = 1099; tick = true
    expect(() => f.arbiter.renewHuman(lease, 1200)).toThrow()
    expect(f.arbiter.state.phase).toBe('releasing')
  })

  test('entitlement/owner loss fences; newly discovered legacy proxy quarantines', () => {
    for (const gate of ['entitled', 'owner', 'legacy'] as const) {
      const f = fixture(); const lease = f.arbiter.acquireHuman(scope, 1100)
      f[gate](gate !== 'entitled')
      let writes = 0
      expect(() => f.arbiter.writeHuman(lease, () => { writes++ })).toThrow()
      expect(writes).toBe(0)
      expect(f.arbiter.state.phase).toBe(gate === 'legacy' ? 'quarantine' : 'releasing')
    }
  })

  test('upstream write throw or async socket failure quarantines without leaking details', () => {
    const f = fixture(); const lease = f.arbiter.acquireHuman(scope, 1100)
    expect(() => f.arbiter.writeHuman(lease, () => { throw new Error('secret endpoint') })).toThrow('Desktop input quarantined')
    expect(f.arbiter.state.phase).toBe('quarantine')
    const g = fixture(); const other = g.arbiter.acquireHuman(scope, 1100)
    g.arbiter.writeHuman(other, () => {})
    g.arbiter.quarantine()
    expect(g.arbiter.valid(other)).toBe(false)
    expect(g.records.at(-1)?.dirty).toBe(true)
  })

  test('scope is copied/frozen and state contains no IDs, generations or writable references', () => {
    const f = fixture(); const mutable = { ...scope }
    const lease = f.arbiter.acquireHuman(mutable, 1100)
    mutable.connectionId = 'changed'
    expect(f.arbiter.valid(lease)).toBe(true)
    expect(Object.isFrozen(lease)).toBe(true)
    expect(f.arbiter.state).toEqual({ phase: 'human', humanExpiresAt: 1100 })
    expect(Object.isFrozen(f.arbiter.state)).toBe(true)
    f.arbiter.revoke(scope)
    expect(f.arbiter.valid(lease)).toBe(false)
  })
})

describe('InputArbiter callback hardening', () => {
  test('callback errors, nonboolean and promises fail closed; no await check race', () => {
    for (const callback of [() => { throw new Error('secret') }, () => undefined, () => Promise.resolve(false)]) {
      const f = fixture({ cooperativeOwnerPresent: callback as unknown as () => boolean })
      expect(() => f.arbiter.acquireHuman(scope, 1100)).toThrow('quarantined')
      expect(f.arbiter.state.phase).toBe('quarantine')
    }
    const f = fixture(); const lease = f.arbiter.acquireHuman(scope, 1100)
    expect(() => f.arbiter.writeHuman(lease, async () => {})).toThrow('quarantined')
    expect(f.arbiter.state.phase).toBe('quarantine')
  })

  test('reentrant admission, revoke, release or write cannot bypass fencing even if callback swallows error', () => {
    for (const nested of ['acquire', 'revoke', 'release', 'write']) {
      let callback: (() => void) | undefined
      const f = fixture({ authorizeHuman: () => { callback?.(); return true } })
      const lease = f.arbiter.acquireHuman(scope, 1100)
      callback = () => {
        try {
          if (nested === 'acquire') f.arbiter.acquireHuman(scope, 1100)
          if (nested === 'revoke') f.arbiter.revoke(scope)
          if (nested === 'release') f.arbiter.beginRelease(lease)
          if (nested === 'write') f.arbiter.writeHuman(lease, () => {})
        } catch { /* malicious/incorrect adapter swallows reentry error */ }
      }
      let writes = 0
      expect(() => f.arbiter.writeHuman(lease, () => { writes++ })).toThrow()
      expect(writes).toBe(0)
      expect(f.arbiter.state.phase).toBe('quarantine')
    }
  })

  test('invalid or backwards clock quarantines rather than extending lease', () => {
    for (const time of [999, NaN, Infinity, -1]) {
      const f = fixture(); const lease = f.arbiter.acquireHuman(scope, 1100)
      f.time(time)
      expect(f.arbiter.valid(lease)).toBe(false)
      expect(f.arbiter.state.phase).toBe('quarantine')
    }
  })

  test('invalid bounds and deadlines never admit', () => {
    for (const maxLeaseMs of [0, -1, NaN, Infinity, 300_001, 0.5]) expect(() => fixture({ maxLeaseMs })).toThrow()
    for (const maxContinuousMs of [0, -1, NaN, Infinity, 300_001]) expect(() => fixture({ maxContinuousMs })).toThrow()
    for (const deadline of [1000, 999, NaN, Infinity, 1000.5]) {
      const f = fixture(); expect(() => f.arbiter.acquireHuman(scope, deadline)).toThrow()
      expect(f.records).toEqual([])
    }
    const f = fixture()
    expect(() => f.arbiter.beginAgent('')).toThrow()
    expect(() => f.arbiter.beginAgent('x'.repeat(257))).toThrow()
    expect(() => f.arbiter.acquireHuman({ ...scope, connectionId: '' }, 1100)).toThrow()
    expect(f.arbiter.state.phase).toBe('idle')
  })
})
