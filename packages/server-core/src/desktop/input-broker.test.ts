import { describe, expect, test } from 'bun:test'
import { connect } from 'node:net'
import type { Socket } from 'node:net'
import { once } from 'node:events'
import { mkdtemp, chmod, lstat, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InputArbiter } from './input-arbiter'
import type { InputArbiterJournal } from './input-arbiter'
import { createUnixInputBroker } from './input-broker'

const identity = { pid: 12345, startTime: '123456789' }
const begin = { op: 'begin', version: 1, operationId: 'fixture-operation', ...identity }
const register = { op: 'register', version: 1, ...identity }
const complete = { op: 'complete', version: 1 }
const scope = { workspaceId: 'workspace', sessionId: 'session', connectionId: 'connection' }

function makeArbiter(initialJournal: InputArbiterJournal = { version: 1, dirty: false }) {
  const records: InputArbiterJournal[] = []
  const arbiter = new InputArbiter({ initialJournal, persistJournal: record => { records.push(record) },
    cooperativeOwnerPresent: () => false, legacyProxyActive: () => false, authorizeHuman: () => true })
  return { arbiter, records }
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'input-broker-'))
  await chmod(directory, 0o700)
  const path = join(directory, 'socket')
  const { arbiter, records } = makeArbiter()
  const broker = await createUnixInputBroker(arbiter, path)
  const sockets: Socket[] = []
  return { directory, path, arbiter, records, broker,
    client: async () => {
      const socket = connect(path)
      sockets.push(socket)
      socket.on('error', () => {})
      const closed = new Promise<void>(accept => socket.once('close', () => accept()))
      let pending = ''
      const lines: unknown[] = []
      const waiters: Array<(line: unknown) => void> = []
      socket.on('data', data => {
        pending += data.toString()
        while (pending.includes('\n')) {
          const newline = pending.indexOf('\n')
          const line: unknown = JSON.parse(pending.slice(0, newline))
          pending = pending.slice(newline + 1)
          const waiter = waiters.shift()
          if (waiter) waiter(line)
          else lines.push(line)
        }
      })
      await once(socket, 'connect')
      return { socket, closed,
        send: (message: unknown) => socket.write(`${JSON.stringify(message)}\n`),
        next: (): Promise<unknown> => lines.length ? Promise.resolve(lines.shift()) : new Promise(accept => waiters.push(accept)),
      }
    },
    cleanup: async () => {
      for (const socket of sockets) socket.destroy()
      await broker.close()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

/** Disposable private Unix fixtures only; no root/live sockets or real tools. */
describe('Unix input broker', () => {
  test('exact versioned handshake, reservation held until real-completion assertion, private call records', async () => {
    const f = await fixture()
    try {
      const client = await f.client()
      client.send(begin)
      expect(await client.next()).toEqual({ op: 'reserved', version: 1 })
      expect(f.arbiter.state.phase).toBe('agent')
      expect(f.broker.activeCalls()).toEqual([{ ...identity, operationId: begin.operationId }])
      expect(Object.isFrozen(f.broker.activeCalls()[0])).toBe(true)
      expect(() => f.arbiter.acquireHuman(scope, Date.now() + 1000)).toThrow()
      expect(f.records.at(-1)?.dirty).toBe(true)
      client.send(complete)
      expect(await client.next()).toEqual({ op: 'finished', version: 1 })
      await client.closed
      expect(f.broker.activeCalls()).toEqual([])
      expect(f.arbiter.state.phase).toBe('idle')
      expect(f.records.at(-1)?.dirty).toBe(false)
      expect((await lstat(f.path)).mode & 0o777).toBe(0o600)
    } finally { await f.cleanup() }
  })

  test('registration is versioned persistent evidence, not an agent reservation or peer identity', async () => {
    const f = await fixture()
    try {
      const client = await f.client(); client.send(register)
      expect(await client.next()).toEqual({ op: 'registered', version: 1 })
      expect(f.broker.registrations()).toEqual([identity])
      expect(Object.isFrozen(f.broker.registrations())).toBe(true)
      expect(f.broker.activeCalls()).toEqual([])
      expect(f.arbiter.state.phase).toBe('idle')
      const duplicate = await f.client(); duplicate.send(register)
      expect(await duplicate.next()).toEqual({ op: 'denied', version: 1 })
      client.socket.end(); await client.closed
      // Bun may deliver client close before the server-side end/close event.
      await observed(() => f.broker.registrations().length === 0)
      expect(f.broker.registrations()).toEqual([])
      expect(f.arbiter.state.phase).toBe('idle')
    } finally { await f.cleanup() }
  })

  test('disconnect without completion and broker shutdown quarantine reserved work durably', async () => {
    for (const disconnect of ['client', 'broker']) {
      const f = await fixture()
      try {
        const client = await f.client(); client.send(begin)
        expect(await client.next()).toEqual({ op: 'reserved', version: 1 })
        if (disconnect === 'client') { client.socket.destroy(); await client.closed }
        await f.broker.close()
        expect(f.arbiter.state.phase).toBe('quarantine')
        expect(f.records.at(-1)?.dirty).toBe(true)
        const restarted = makeArbiter(f.records.at(-1)!).arbiter
        expect(restarted.state.phase).toBe('quarantine')
        expect(() => restarted.beginAgent('restart')).toThrow()
      } finally { await f.cleanup() }
    }
  })

  test('broker shutdown immediately fences active human lease, even with no agent calls', async () => {
    const f = await fixture()
    try {
      const lease = f.arbiter.acquireHuman(scope, Date.now() + 5000)
      const closing = f.broker.close()
      expect(f.arbiter.valid(lease)).toBe(false)
      expect(f.arbiter.state.phase).toBe('quarantine')
      expect(() => f.arbiter.writeHuman(lease, () => { throw new Error('must not execute') })).toThrow()
      expect(f.records.at(-1)?.dirty).toBe(true)
      await closing
    } finally { await f.cleanup() }
  })

  test('fresh handshake deadline only denies unreserved clients and never implies completion', async () => {
    const f = await fixture()
    try {
      const client = await f.client()
      expect(await client.next()).toEqual({ op: 'denied', version: 1 })
      await client.closed
      expect(f.arbiter.state.phase).toBe('idle')
      expect(f.records).toEqual([])
    } finally { await f.cleanup() }
  }, 10_000)

  test('disconnect/partial frame before reservation is harmless; no timeout ever releases an active call', async () => {
    const f = await fixture()
    try {
      const partial = await f.client(); partial.socket.write('{"op":"beg'); partial.socket.end()
      await partial.closed
      const client = await f.client(); client.send(begin)
      expect(await client.next()).toEqual({ op: 'reserved', version: 1 })
      await new Promise(accept => setTimeout(accept, 30))
      expect(f.arbiter.state.phase).toBe('agent')
      expect(f.records).toEqual([{ version: 1, dirty: true }])
      client.send(complete); expect(await client.next()).toEqual({ op: 'finished', version: 1 })
      expect(f.arbiter.state.phase).toBe('idle')
    } finally { await f.cleanup() }
  })

  test('fragmented frames work; exact schema, unknown ops, versions, duplicate keys and payloads deny', async () => {
    const f = await fixture()
    try {
      const client = await f.client()
      const encoded = JSON.stringify(begin)
      client.socket.write(encoded.slice(0, 12)); client.socket.write(`${encoded.slice(12)}\n`)
      expect(await client.next()).toEqual({ op: 'reserved', version: 1 })
      client.send(complete); expect(await client.next()).toEqual({ op: 'finished', version: 1 })
      const invalid = [
        {}, [], null, { ...begin, version: 2 }, { ...begin, op: 'read' }, { ...begin, args: { secret: 'not-allowed' } },
        { ...begin, pid: -1 }, { ...begin, pid: 1.5 }, { ...begin, pid: '12345' }, { ...begin, startTime: '' },
        { ...begin, startTime: 'not-proc-start' }, { ...begin, operationId: 'x'.repeat(257) },
        { ...begin, operationId: 'contains\nline' }, { ...complete },
      ]
      for (const message of invalid) {
        const bad = await f.client(); bad.send(message)
        expect(await bad.next()).toEqual({ op: 'denied', version: 1 })
        await bad.closed
        expect(f.arbiter.state.phase).toBe('idle')
      }
      for (const raw of [
        '{"op":"register","version":2,"version":1,"pid":12345,"startTime":"1"}\n',
        '{"op":"register","version":1,"\\u0076ersion":1,"pid":12345,"startTime":"1"}\n',
        '{"op":"register","version":1,"pid":12345,"startTime":"1",}\n',
        'garbage\n',
      ]) {
        const bad = await f.client(); bad.socket.write(raw)
        expect(await bad.next()).toEqual({ op: 'denied', version: 1 })
        await bad.closed
      }
    } finally { await f.cleanup() }
  })

  test('unknown/extra completion fields during a reservation quarantine; no metadata escape', async () => {
    for (const invalid of [{ op: 'exit', version: 1 }, { ...complete, result: 'sensitive-result' }, { ...complete, version: 2 }]) {
      const f = await fixture()
      try {
        const client = await f.client(); client.send(begin)
        expect(await client.next()).toEqual({ op: 'reserved', version: 1 })
        client.send(invalid)
        expect(await client.next()).toEqual({ op: 'denied', version: 1 })
        expect(f.arbiter.state.phase).toBe('quarantine')
        expect(f.broker.activeCalls()).toEqual([])
      } finally { await f.cleanup() }
    }
  })

  test('oversize newline-free and fragmented frames are bounded and deny', async () => {
    const f = await fixture()
    try {
      for (const fragmented of [false, true]) {
        const client = await f.client()
        if (fragmented) { client.socket.write('x'.repeat(3000)); client.socket.write('x'.repeat(1097)) }
        else client.socket.write('x'.repeat(4097))
        expect(await client.next()).toEqual({ op: 'denied', version: 1 })
        await client.closed
      }
      const invalidUtf8 = await f.client()
      invalidUtf8.socket.write(Buffer.concat([Buffer.from('{"op":"'), Buffer.from([0xff]), Buffer.from('"}\n')]))
      expect(await invalidUtf8.next()).toEqual({ op: 'denied', version: 1 })
      expect(f.arbiter.state.phase).toBe('idle')
    } finally { await f.cleanup() }
  })

  test('same-turn takeover vs brokered mutator and simultaneous agent calls have a single winner', async () => {
    const f = await fixture()
    try {
      const lease = f.arbiter.acquireHuman(scope, Date.now() + 5000)
      const blocked = await f.client(); blocked.send(begin)
      expect(await blocked.next()).toEqual({ op: 'denied', version: 1 })
      expect(f.arbiter.valid(lease)).toBe(true)
      f.arbiter.beginRelease(lease); f.arbiter.finishRelease(lease, true)
      const a = await f.client(); const b = await f.client()
      a.send(begin); b.send({ ...begin, operationId: 'other-operation' })
      const results = await Promise.all([a.next(), b.next()])
      expect(results.filter(result => (result as { op: string }).op === 'reserved')).toHaveLength(1)
      expect(results.filter(result => (result as { op: string }).op === 'denied')).toHaveLength(1)
      const winner = (results[0] as { op: string }).op === 'reserved' ? a : b
      winner.send(complete); expect(await winner.next()).toEqual({ op: 'finished', version: 1 })
      expect(f.arbiter.state.phase).toBe('idle')
    } finally { await f.cleanup() }
  })

  test('at most 64 clients; unregistered connection closure does not quarantine', async () => {
    const f = await fixture()
    try {
      for (let i = 0; i < 64; i++) {
        const client = await f.client()
        client.send({ ...register, pid: i + 1 })
        expect(await client.next()).toEqual({ op: 'registered', version: 1 })
      }
      const overflow = await f.client()
      await overflow.closed
      expect(f.broker.registrations()).toHaveLength(64)
      expect(f.arbiter.state.phase).toBe('idle')
    } finally { await f.cleanup() }
  })

  test('private existing parent required; no overwrite or automatic stale-socket deletion', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'input-broker-'))
    const path = join(directory, 'socket')
    const { arbiter } = makeArbiter()
    try {
      await chmod(directory, 0o755)
      await expect(createUnixInputBroker(arbiter, path)).rejects.toThrow('private')
      await chmod(directory, 0o700)
      await writeFile(path, 'existing fixture', { mode: 0o600 })
      await expect(createUnixInputBroker(arbiter, path)).rejects.toThrow('already exists')
      await expect(createUnixInputBroker(arbiter, 'relative.sock')).rejects.toThrow('Invalid')
      await expect(createUnixInputBroker(arbiter, join(directory, 'missing', 'socket'))).rejects.toThrow()
      const link = `${directory}-link`
      await symlink(directory, link)
      try { await expect(createUnixInputBroker(arbiter, join(link, 'other'))).rejects.toThrow('private') }
      finally { await rm(link) }
      expect(freshState(arbiter)).toBe('idle')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
function freshState(arbiter: InputArbiter) { return arbiter.state.phase }

/** Bounded test-only event-loop drain, never used for arbitration or reservation release. */
async function observed(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000
  while (!condition() && Date.now() < deadline) await new Promise(accept => setTimeout(accept, 5))
  expect(condition()).toBe(true)
}
