import { describe, expect, it } from 'bun:test'
import { createWorkspaceMetadataLoader } from '../workspace-metadata-loader'

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function setup(load: () => Promise<string[]>) {
  let data: string[] = []
  let error: string | null = null
  let loading = false
  const pending = new Map<number, () => void>()
  let id = 0
  const loader = createWorkspaceMetadataLoader({
    load,
    onData: next => { data = next },
    onLoading: next => { loading = next },
    onError: next => { error = next },
    timers: { set: fn => { pending.set(++id, fn); return id }, clear: key => { pending.delete(key as number) } },
  })
  return { loader, pending, state: () => ({ data, error, loading }), tick: async () => {
    const calls = [...pending.values()]; pending.clear(); calls.forEach(fn => fn());
    await Promise.resolve(); await Promise.resolve()
  } }
}

describe('workspace metadata hydration recovery', () => {
  it('reproduces initial RPC failure and recovers on a connected-event refresh', async () => {
    let available = false
    const h = setup(async () => { if (!available) throw new Error('Not connected'); return ['puck', 'puck-subagent', 'puck-automation'] })
    await h.loader.refresh()
    expect(h.state()).toEqual({ data: [], error: 'Not connected', loading: false })
    available = true
    await h.loader.refresh()
    expect(h.state().data).toHaveLength(3)
    expect(h.state().error).toBeNull()
    expect(h.pending.size).toBe(0)
  })
  it('retries a transient failure even if no new connection event is emitted', async () => {
    let count = 0
    const h = setup(async () => { if (++count === 1) throw new Error('timeout'); return ['puck'] })
    await h.loader.refresh(); await h.tick()
    expect(h.state().data).toEqual(['puck'])
    expect(count).toBe(2)
  })
  it('bounds retries and allows later recovery rather than polling forever', async () => {
    let count = 0
    const h = setup(async () => { count++; throw new Error('offline') })
    await h.loader.refresh()
    for (let i = 0; i < 10; i++) await h.tick()
    expect(count).toBe(4)
    expect(h.pending.size).toBe(0)
    await h.loader.refresh()
    expect(count).toBe(5)
    h.loader.dispose()
    expect(h.pending.size).toBe(0)
  })
  it('preserves same-workspace data across a failed refresh, including a legitimate empty result', async () => {
    let fail = false
    let data = ['puck']
    const h = setup(async () => { if (fail) throw new Error('offline'); return data })
    await h.loader.refresh(); fail = true; await h.loader.refresh()
    expect(h.state().data).toEqual(['puck'])
    fail = false; data = []; await h.loader.refresh()
    expect(h.state().data).toEqual([])
    expect(h.state().error).toBeNull()
  })
  it('ignores stale overlapping results and their errors/loading state', async () => {
    const old = deferred<string[]>()
    let count = 0
    const h = setup(() => ++count === 1 ? old.promise : Promise.resolve(['latest']))
    const first = h.loader.refresh(); await h.loader.refresh()
    old.reject(new Error('stale timeout')); await first
    expect(h.state()).toEqual({ data: ['latest'], error: null, loading: false })
    expect(h.pending.size).toBe(0)
  })
  it('ignores old workspace completions and cancels retries on unmount/switch', async () => {
    const old = deferred<string[]>()
    const a = setup(() => old.promise)
    const first = a.loader.refresh(); a.loader.dispose()
    const b = setup(async () => ['workspace-b']); await b.loader.refresh()
    old.resolve(['workspace-a']); await first
    expect(a.state().data).toEqual([])
    expect(b.state().data).toEqual(['workspace-b'])
    expect(a.pending.size).toBe(0)
  })
})
