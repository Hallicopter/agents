import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as backendFactory from '../../../shared/src/agent/backend/factory'
import { SessionManager, createManagedSession } from './SessionManager'
import { loadSession, sessionPersistenceQueue } from '@craft-agent/shared/sessions'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

// Exercise the actual server acceptance boundary, not an extracted callback.
describe('cross-session message acceptance', () => {
  let root: string
  let sm: SessionManager
  let host: any
  let events: any[]
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-acceptance-'))
    sm = new SessionManager()
    host = sm as any
    spyOn(backendFactory, 'resolveSessionConnection').mockReturnValue(null)
    host.decisionFeatureActive = () => false
    events = []
    host.sendEvent = (event: any) => events.push(event)
  })
  afterEach(async () => {
    mock.restore()
    await sessionPersistenceQueue.flushAll()
    rmSync(root, { recursive: true, force: true })
  })
  function session(id = 'target') {
    const managed = createManagedSession({ id, name: 'Existing worker' },
      { id: 'test', name: 'Test', rootPath: root, createdAt: Date.now() } as never,
      { messagesLoaded: true })
    host.sessions.set(id, managed)
    return managed
  }

  it('returns durable idle acceptance while the recipient task remains pending, then surfaces failure separately', async () => {
    const target = session()
    const pending = deferred<never>()
    host.getOrCreateAgent = () => pending.promise
    let finished = false
    const original = sm.sendMessage.bind(sm)
    host.sendMessage = (...args: Parameters<SessionManager['sendMessage']>) => original(...args).finally(() => { finished = true })
    const result = await host.acceptAgentMessage(target.id, 'work independently')
    expect(result).toEqual({ delivery: 'delivered', targetBusy: false })
    expect(finished).toBe(false)
    expect(target.isProcessing).toBe(true)
    expect(loadSession(root, target.id)?.messages.some(m => m.content === 'work independently')).toBe(true)
    expect(events.some(e => e.type === 'user_message' && e.status === 'accepted')).toBe(true)
    pending.reject(new Error('worker setup failed'))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(finished).toBe(true)
    expect(target.isProcessing).toBe(false)
    expect(events.some(e => e.type === 'complete')).toBe(true)
    expect(events.some(e => e.type === 'error' && e.error.includes('worker setup failed'))).toBe(true)
  })

  it('returns before a pending model stream and preserves the normal completion hook', async () => {
    const target = session()
    const streamEntered = deferred()
    const release = deferred()
    const stopped = deferred<string>()
    host.startPreTurnDecisions = () => null
    host.getOrCreateAgent = async () => ({
      setAllSources() {}, getModel: () => 'test', getSessionId: () => null,
      async *chat() {
        streamEntered.resolve()
        await release.promise
        yield { type: 'complete' }
      },
    })
    // Keep the real iterator and lifecycle dispatch, isolate downstream UI/task
    // bookkeeping (covered by the existing processing-stop/background suites).
    host.processEvent = async () => {}
    host.onProcessingStopped = (_id: string, reason: string) => {
      target.isProcessing = false
      stopped.resolve(reason)
    }
    expect((await host.acceptAgentMessage(target.id, 'work')).delivery).toBe('delivered')
    await streamEntered.promise
    expect(target.isProcessing).toBe(true)
    release.resolve()
    expect(await stopped.promise).toBe('complete')
  })

  it('serializes concurrent dispatch acceptance and queues busy messages exactly once in FIFO order', async () => {
    const target = session()
    const pending = deferred<never>()
    host.getOrCreateAgent = () => pending.promise
    const results = await Promise.all(['one', 'two', 'three'].map(message => host.acceptAgentMessage(target.id, message)))
    expect(results.map(r => r.delivery)).toEqual(['delivered', 'queued', 'queued'])
    expect(target.messageQueue.map(m => m.message)).toEqual(['two', 'three'])
    expect(target.messages.map(m => m.content)).toEqual(['one', 'two', 'three'])
    expect(loadSession(root, target.id)?.messages.filter(m => m.isQueued).map(m => m.content)).toEqual(['two', 'three'])
    expect(events.filter(e => e.type === 'user_message' && e.status === 'queued')).toHaveLength(2)
    pending.reject(new Error('test cleanup'))
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(target.isProcessing).toBe(false)
    expect(target.messageQueue).toHaveLength(0)
    expect(events.some(e => e.type === 'complete')).toBe(true)
  })

  it('reports an actual busy steer as delivered, not queued', async () => {
    const target = session()
    target.isProcessing = true
    target.agent = { redirect: () => true } as never
    expect(await host.acceptAgentMessage(target.id, 'steer')).toEqual({ delivery: 'delivered', targetBusy: true })
    expect(target.messageQueue).toHaveLength(0)
  })

  it('rejects unknown sessions and releases the acceptance lock', async () => {
    await expect(host.acceptAgentMessage('missing', 'hello')).rejects.toThrow('not found')
    expect(host.agentMessageAcceptances.size).toBe(0)
  })

  it('rejects unconfirmed persistence without claiming delivery or starting the idle worker', async () => {
    const target = session()
    host.persistSession = () => {}
    host.flushSession = async () => {}
    let started = false
    host.getOrCreateAgent = () => { started = true; throw new Error('must not start') }
    await expect(host.acceptAgentMessage(target.id, 'not on disk')).rejects.toThrow('delivery is uncertain')
    expect(started).toBe(false)
    expect(target.isProcessing).toBe(false)
  })

  it('reports an unexpected post-ack rejection without changing the accepted result', async () => {
    const target = session()
    target.isProcessing = true
    const original = sm.sendMessage.bind(sm)
    host.sendMessage = async (...args: Parameters<SessionManager['sendMessage']>) => {
      await original(...args)
      throw new Error('unexpected detached rejection')
    }
    expect((await host.acceptAgentMessage(target.id, 'queued')).delivery).toBe('queued')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(events.some(e => e.type === 'error' && e.error.includes('unexpected detached rejection'))).toBe(true)
    expect(target.messageQueue).toHaveLength(1)
  })

  it('does not claim durable queueing when a busy write cannot be confirmed', async () => {
    const target = session()
    target.isProcessing = true
    host.persistSession = () => {}
    host.flushSession = async () => {}
    await expect(host.acceptAgentMessage(target.id, 'queued')).rejects.toThrow('do not automatically resend')
    // Existing queue is retained, not silently dropped or duplicated on error.
    expect(target.messageQueue.map(m => m.message)).toEqual(['queued'])
  })

  it('rejects pre-ack errors and a completed send without an acknowledgement', async () => {
    session()
    host.sendMessage = async () => { throw new Error('pre-ack failure') }
    await expect(host.acceptAgentMessage('target', 'hello')).rejects.toThrow('pre-ack failure')
    host.sendMessage = async () => {}
    await expect(host.acceptAgentMessage('target', 'hello')).rejects.toThrow('did not acknowledge')
  })

  it('allows a worker reply to an idle parent without coupling either turn completion', async () => {
    session('parent')
    session('worker')
    const pending = deferred<never>()
    host.getOrCreateAgent = () => pending.promise
    expect((await host.acceptAgentMessage('worker', 'do work')).delivery).toBe('delivered')
    expect((await host.acceptAgentMessage('parent', 'worker report')).delivery).toBe('delivered')
    expect(events.filter(e => e.type === 'user_message').map(e => e.sessionId)).toEqual(['worker', 'parent'])
    pending.reject(new Error('test cleanup'))
    await new Promise(resolve => setTimeout(resolve, 10))
  })
})
