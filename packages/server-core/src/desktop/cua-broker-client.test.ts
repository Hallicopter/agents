import { describe, expect, test } from 'bun:test'
import { createServer } from 'node:net'
import type { Socket } from 'node:net'
import { mkdtemp, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InputArbiter } from './input-arbiter'
import type { AgentReservation, InputArbiterJournal } from './input-arbiter'
import { createUnixInputBroker } from './input-broker'
import { createCuaBrokerClient } from './cua-broker-client'
import type { CuaBrokerClient, CuaBrokerClientOptions } from './cua-broker-client'

const reads = ['list_apps', 'list_windows', 'get_screen_size', 'health_report']
const mutations = ['launch_app', 'click', 'double_click', 'right_click', 'drag', 'type_text', 'press_key', 'hotkey', 'scroll', 'check_permissions', 'start_session', 'end_session', 'get_window_state', 'get_desktop_state']
const scope = { workspaceId: 'workspace', sessionId: 'session', connectionId: 'connection' }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((accept, deny) => { resolve = accept; reject = deny })
  return { promise, resolve, reject }
}
function core() {
  const records: InputArbiterJournal[] = []
  const arbiter = new InputArbiter({ initialJournal: { version: 1, dirty: false }, persistJournal: record => { records.push(record) },
    cooperativeOwnerPresent: () => false, legacyProxyActive: () => false, authorizeHuman: () => true })
  return { arbiter, records }
}
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'cua-client-'))
  await chmod(path, 0o700)
  return path
}
async function fixture<T>(upstream: CuaBrokerClientOptions<T>['upstream'], options: Partial<CuaBrokerClientOptions<T>> = {}) {
  const dir = await directory()
  const path = join(dir, 'socket')
  const { arbiter, records } = core()
  const broker = await createUnixInputBroker(arbiter, path)
  const client = await createCuaBrokerClient({ socketPath: path, pid: 12345, startTime: '123456', upstream, ...options })
  return { arbiter, records, broker, client, path,
    cleanup: async () => { client.close(); await broker.close(); await rm(dir, { recursive: true, force: true }) },
  }
}
/** Test-only bounded transport observation, never a release or production timeout. */
async function observed(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000
  while (!condition() && Date.now() < deadline) await new Promise(accept => setTimeout(accept, 5))
  expect(condition()).toBe(true)
}

/** All fixtures are disposable private Unix sockets and fake promises. No actual CUA tools. */
describe('trusted CUA broker client', () => {
  test('exact known reads have no reservation; every known mutator reserves through completed result', async () => {
    let f!: Awaited<ReturnType<typeof fixture<object>>>
    const result = { content: [{ type: 'text', text: 'fixture' }], structuredContent: { stable: true } }
    const calls: string[] = []
    f = await fixture(async (name, args) => {
      calls.push(name)
      expect(args).toEqual({ fixture: 'args' })
      expect(f.arbiter.state.phase).toBe(reads.includes(name) ? 'idle' : 'agent')
      return result
    })
    try {
      for (const name of reads) {
        expect(await f.client.callTool(name, { fixture: 'args' })).toBe(result)
        expect(f.records).toEqual([])
      }
      for (const name of mutations) {
        expect(await f.client.callTool(name, { fixture: 'args' })).toBe(result)
        expect(f.arbiter.state.phase).toBe('idle')
      }
      expect(calls).toEqual([...reads, ...mutations])
      expect(f.records.filter(record => record.dirty)).toHaveLength(mutations.length)
    } finally { await f.cleanup() }
  })

  test('state capture reserves with default snapshot side effects or screenshot_out_file, and cannot bypass human lease', async () => {
    let f!: Awaited<ReturnType<typeof fixture<object>>>
    let calls = 0
    f = await fixture(async () => { calls++; expect(f.arbiter.state.phase).toBe('agent'); return {} })
    try {
      for (const name of ['get_window_state', 'get_desktop_state']) {
        for (const args of [{}, { screenshot_out_file: '/synthetic/never-written.png' }]) {
          await f.client.callTool(name, args)
          expect(f.arbiter.state.phase).toBe('idle')
        }
      }
      expect(calls).toBe(4)
      const lease = f.arbiter.acquireHuman(scope, Date.now() + 5000)
      for (const name of ['get_window_state', 'get_desktop_state']) {
        await expect(f.client.callTool(name, { screenshot_out_file: '/synthetic/never-written.png' })).rejects.toThrow('unavailable')
      }
      expect(calls).toBe(4)
      expect(f.arbiter.valid(lease)).toBe(true)
    } finally { await f.cleanup() }
  })

  test('unknown tools, aliases, inherited names and clipboard/config operations deny without upstream', async () => {
    let called = false
    const f = await fixture(async () => { called = true; return {} })
    try {
      for (const name of ['', 'CLICK', 'click ', 'unknown', 'get_clipboard', 'set_clipboard', 'close_app', 'configure', 'constructor', '__proto__', 'toString']) {
        await expect(f.client.callTool(name, { secret: 'not-broker-metadata' })).rejects.toThrow('denied')
      }
      expect(called).toBe(false)
      expect(f.records).toEqual([])
    } finally { await f.cleanup() }
  })

  test('no reservation means no upstream send, including a human lease or aborted call', async () => {
    let called = false
    const f = await fixture(async () => { called = true; return {} })
    try {
      const lease = f.arbiter.acquireHuman(scope, Date.now() + 5000)
      await expect(f.client.callTool('click', {})).rejects.toThrow('unavailable')
      expect(called).toBe(false)
      expect(f.arbiter.valid(lease)).toBe(true)
      f.arbiter.beginRelease(lease); f.arbiter.finishRelease(lease, true)
      const controller = new AbortController(); controller.abort()
      await expect(f.client.callTool('click', {}, { signal: controller.signal })).rejects.toThrow()
      expect(called).toBe(false)
      expect(f.arbiter.state.phase).toBe('idle')
    } finally { await f.cleanup() }
  })

  test('actual asynchronous completion, not dispatch, releases; zero pending queue and reentry deny', async () => {
    const done = deferred<object>(); const dispatched = deferred<void>()
    let f!: Awaited<ReturnType<typeof fixture<object>>>
    let count = 0
    f = await fixture(async () => {
      count++
      await expect(f.client.callTool('health_report', {})).rejects.toThrow('denied')
      dispatched.resolve(); return done.promise
    })
    try {
      const result = { content: [], structuredContent: { original: true } }
      let settled = false
      const call = f.client.callTool('click', {}).finally(() => { settled = true })
      await dispatched.promise
      expect(f.arbiter.state.phase).toBe('agent')
      expect(settled).toBe(false)
      await expect(f.client.callTool('click', {})).rejects.toThrow('denied')
      expect(f.broker.activeCalls()).toHaveLength(1)
      expect(count).toBe(1)
      done.resolve(result)
      expect(await call).toBe(result)
      expect(f.arbiter.state.phase).toBe('idle')
    } finally { await f.cleanup() }
  })

  test('fulfilled isError result preserved ONLY under trusted completed-handler contract, no replay', async () => {
    const result = { isError: true, content: [{ type: 'text', text: 'completed fixture failure' }], structuredContent: { original: 7 } }
    let count = 0
    const f = await fixture(async () => { count++; return result })
    try {
      expect(await f.client.callTool('launch_app', {})).toBe(result)
      expect(count).toBe(1)
      expect(f.arbiter.state.phase).toBe('idle')
    } finally { await f.cleanup() }
  })

  test('synchronous throw and asynchronous rejection are uncertain, disconnect and never complete/retry', async () => {
    for (const sync of [true, false]) {
      let calls = 0
      const upstream = (() => { calls++; if (sync) throw new Error('sensitive error'); return Promise.reject(new Error('sensitive error')) })
      const f = await fixture(upstream)
      try {
        await expect(f.client.callTool('click', {})).rejects.toThrow('CUA broker uncertain')
        await observed(() => f.arbiter.state.phase === 'quarantine')
        expect(calls).toBe(1)
        expect(f.records.every(record => record.dirty)).toBe(true)
      } finally { await f.cleanup() }
    }
  })

  test('hung completion deadline quarantines; late upstream resolution NEVER sends complete or clears dirty', async () => {
    const done = deferred<object>()
    let calls = 0
    const f = await fixture(async () => { calls++; return done.promise }, { completionTimeoutMs: 25 })
    try {
      await expect(f.client.callTool('drag', {})).rejects.toThrow('uncertain')
      await observed(() => f.arbiter.state.phase === 'quarantine')
      expect(f.records.every(record => record.dirty)).toBe(true)
      done.resolve({ content: [] })
      await new Promise(accept => setTimeout(accept, 20))
      expect(f.records.every(record => record.dirty)).toBe(true)
      expect(f.arbiter.state.phase).toBe('quarantine')
      expect(calls).toBe(1)
    } finally { await f.cleanup() }
  })

  test('abort after dispatch is uncertainty; late resolution cannot release reservation', async () => {
    const done = deferred<object>(); const dispatched = deferred<void>()
    const f = await fixture(async () => { dispatched.resolve(); return done.promise })
    const controller = new AbortController()
    try {
      const call = f.client.callTool('press_key', {}, { signal: controller.signal })
      const failure = call.then(() => undefined, error => error as Error)
      await dispatched.promise
      controller.abort()
      expect((await failure)?.message).toBe('CUA broker uncertain')
      await observed(() => f.arbiter.state.phase === 'quarantine')
      done.resolve({})
      await new Promise(accept => setTimeout(accept, 10))
      expect(f.records.every(record => record.dirty)).toBe(true)
    } finally { await f.cleanup() }
  })

  test('client close or broker death during active upstream fences all new calls and quarantines', async () => {
    for (const loss of ['client', 'broker']) {
      const done = deferred<object>(); const dispatched = deferred<void>()
      const f = await fixture(async () => { dispatched.resolve(); return done.promise })
      try {
        const call = f.client.callTool('scroll', {})
        const failure = call.then(() => undefined, error => error as Error)
        await dispatched.promise
        if (loss === 'client') f.client.close()
        else await f.broker.close()
        expect((await failure)?.message).toBe('CUA broker uncertain')
        await observed(() => f.arbiter.state.phase === 'quarantine')
        await expect(f.client.callTool('health_report', {})).rejects.toThrow('unavailable')
        await expect(f.client.callTool('click', {})).rejects.toThrow('unavailable')
        done.resolve({})
        expect(f.records.every(record => record.dirty)).toBe(true)
      } finally { await f.cleanup() }
    }
  })

  test('missing/unavailable broker, bad configuration and no persistent registration deny construction', async () => {
    const dir = await directory()
    try {
      const base = { socketPath: join(dir, 'missing'), pid: 1, startTime: '1', upstream: async () => ({}) }
      await expect(createCuaBrokerClient(base)).rejects.toThrow('unavailable')
      for (const changes of [{ socketPath: 'relative' }, { pid: 0 }, { startTime: 'bad' }, { brokerTimeoutMs: 0 }, { completionTimeoutMs: 300_001 }]) {
        await expect(createCuaBrokerClient({ ...base, ...changes })).rejects.toThrow('denied')
      }
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})

interface FakeControls { readonly registration: () => Socket | undefined; readonly socket: Socket }
async function fakeFixture(onBegin: (controls: FakeControls) => void, onRegister?: (socket: Socket) => void) {
  const dir = await directory(); const path = join(dir, 'socket')
  const { arbiter, records } = core()
  const sockets = new Set<Socket>()
  const frames: Array<Record<string, unknown>> = []
  let registration: Socket | undefined
  const server = createServer(socket => {
    sockets.add(socket)
    let pending = ''
    let held: AgentReservation | undefined
    socket.on('error', () => {})
    socket.on('data', data => {
      pending += data.toString()
      while (pending.includes('\n')) {
        const newline = pending.indexOf('\n')
        const message = JSON.parse(pending.slice(0, newline)) as Record<string, unknown>
        pending = pending.slice(newline + 1)
        frames.push(message)
        if (message.op === 'register') {
          registration = socket
          if (onRegister) onRegister(socket)
          else socket.write('{"op":"registered","version":1}\n')
        } else if (message.op === 'begin') {
          held = arbiter.beginAgent(message.operationId as string)
          onBegin({ registration: () => registration, socket })
        } else if (message.op === 'complete') {
          arbiter.finishAgent(held!, true); held = undefined
          socket.end('{"op":"finished","version":1}\n')
        }
      }
    })
    socket.on('close', () => {
      if (held) { try { arbiter.finishAgent(held, false) } catch {} }
      sockets.delete(socket)
    })
  })
  await new Promise<void>(accept => server.listen(path, accept))
  await chmod(path, 0o600)
  const clients: CuaBrokerClient<unknown>[] = []
  return { arbiter, records, frames,
    client: async <T>(upstream: (name: string, args: unknown) => Promise<T>, options: Partial<CuaBrokerClientOptions<T>> = {}) => {
      const client = await createCuaBrokerClient({ socketPath: path, pid: 12345, startTime: '1', upstream, brokerTimeoutMs: 50, ...options })
      clients.push(client)
      return client
    },
    cleanup: async () => {
      for (const client of clients) client.close()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(accept => server.close(() => accept()))
      await rm(dir, { recursive: true, force: true })
    },
  }
}

describe('CUA broker await-boundary fencing', () => {
  test('abort/timeout before reserved ACK closes pending begin (already reserved server-side)', async () => {
    for (const stop of ['abort', 'timeout']) {
      const controller = new AbortController()
      const f = await fakeFixture(() => { if (stop === 'abort') controller.abort() })
      let called = false
      try {
        const client = await f.client(async () => { called = true; return {} })
        await expect(client.callTool('click', {}, { signal: controller.signal })).rejects.toThrow('unavailable')
        await observed(() => f.arbiter.state.phase === 'quarantine')
        expect(called).toBe(false)
        expect(f.frames.map(frame => frame.op)).toEqual(['register', 'begin'])
      } finally { await f.cleanup() }
    }
  })

  test('registration loss while awaiting reserved destroys active call; no late ACK dispatch', async () => {
    const f = await fakeFixture(({ registration, socket }) => {
      registration()!.destroy()
      setTimeout(() => { if (!socket.destroyed) socket.write('{"op":"reserved","version":1}\n') }, 20)
    })
    let called = false
    try {
      const client = await f.client(async () => { called = true; return {} })
      await expect(client.callTool('click', {})).rejects.toThrow('unavailable')
      await observed(() => f.arbiter.state.phase === 'quarantine')
      expect(called).toBe(false)
      await expect(client.callTool('health_report', {})).rejects.toThrow('unavailable')
      expect(f.frames.map(frame => frame.op)).toEqual(['register', 'begin'])
    } finally { await f.cleanup() }
  })

  test('bad reserved ACK, duplicate keys, unknown version and oversized response deny before upstream', async () => {
    for (const ack of ['{"op":"reserved","version":2}\n', '{"op":"reserved","version":2,"version":1}\n', 'x'.repeat(4097), '{"op":"reserved","version":1,"extra":true}\n']) {
      const f = await fakeFixture(({ socket }) => { socket.write(ack) })
      let called = false
      try {
        const client = await f.client(async () => { called = true; return {} })
        await expect(client.callTool('click', {})).rejects.toThrow('unavailable')
        await observed(() => f.arbiter.state.phase === 'quarantine')
        expect(called).toBe(false)
        expect(f.frames.every(frame => frame.op !== 'complete')).toBe(true)
      } finally { await f.cleanup() }
    }
  })

  test('raw tool arguments never enter broker protocol and original result is returned intact', async () => {
    const f = await fakeFixture(({ socket }) => { socket.write('{"op":"reserved","version":1}\n') })
    const args = { password: 'fixture-secret-never-to-broker', nested: { document: 'fixture-private-document' } }
    const result = { structuredContent: args, content: [{ type: 'text', text: 'original' }] }
    try {
      const client = await f.client(async (name, actual) => { expect(name).toBe('type_text'); expect(actual).toBe(args); return result })
      expect(await client.callTool('type_text', args)).toBe(result)
      expect(f.frames.map(frame => frame.op)).toEqual(['register', 'begin', 'complete'])
      expect(Object.keys(f.frames[1]!).sort()).toEqual(['op', 'operationId', 'pid', 'startTime', 'version'])
      expect(JSON.stringify(f.frames)).not.toContain('fixture-secret')
      expect(JSON.stringify(f.frames)).not.toContain('fixture-private-document')
    } finally { await f.cleanup() }
  })

  test('invalid/oversize registration or hung handshake never admits any tool', async () => {
    for (const response of ['{"op":"registered","version":2}\n', 'x'.repeat(4097), undefined]) {
      const f = await fakeFixture(() => {}, socket => { if (response) socket.write(response) })
      let called = false
      try {
        await expect(f.client(async () => { called = true; return {} })).rejects.toThrow('unavailable')
        expect(called).toBe(false)
        expect(f.frames.map(frame => frame.op)).toEqual(['register'])
        expect(f.arbiter.state.phase).toBe('idle')
      } finally { await f.cleanup() }
    }
  })
})
