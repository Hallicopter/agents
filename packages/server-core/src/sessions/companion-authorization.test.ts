import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSessionFilePath } from '@craft-agent/shared/sessions/storage'
import * as backendFactory from '../../../shared/src/agent/backend/factory.ts'
import { SessionManager, createManagedSession } from './SessionManager'

describe('companion message authorization boundaries', () => {
  let root: string
  let sm: SessionManager
  let managed: ReturnType<typeof createManagedSession>
  let allowed: boolean
  const authorize = () => { if (!allowed) throw new Error('revoked or escalated') }
  const send = (text = 'phone message') => sm.sendMessage(managed.id, text, undefined, undefined, undefined, undefined, undefined, undefined, undefined, authorize)

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'companion-authorization-'))
    sm = new SessionManager()
    managed = createManagedSession({ id: 'guarded', name: 'Guarded' }, { id: 'ws', name: 'Test', rootPath: root, createdAt: 1 } as any, { messagesLoaded: true })
    ;(sm as any).sessions.set(managed.id, managed)
    sm.setEventSink(() => {})
    ;(sm as any).decisionFeatureActive = () => false
    allowed = true
  })
  afterEach(() => { mock.restore(); rmSync(root, { recursive: true, force: true }) })
  const tick = () => new Promise<void>(resolve => setImmediate(resolve))

  it('rejects mode escalation/revocation during message loading before acceptance or redirect', async () => {
    managed.isProcessing = true
    const redirect = mock(() => true)
    managed.agent = { redirect } as any
    ;(sm as any).ensureMessagesLoaded = async () => { await Promise.resolve(); allowed = false }
    await expect(send()).rejects.toThrow('revoked or escalated')
    expect(managed.messages).toHaveLength(0)
    expect(managed.messageQueue).toHaveLength(0)
    expect(redirect).not.toHaveBeenCalled()
  })

  it('rejects revocation during durable acceptance before ack or turn claim', async () => {
    ;(sm as any).persistSession = () => {}
    ;(sm as any).flushSession = async () => { allowed = false }
    const ack = mock(() => {})
    await expect(sm.sendMessage(managed.id, 'message', undefined, undefined, undefined, undefined, undefined, ack, undefined, authorize)).rejects.toThrow('revoked or escalated')
    expect(ack).not.toHaveBeenCalled()
    expect(managed.isProcessing).toBe(false)
  })

  it('never titles or auto-labels denied text in an unnamed session after flush revocation', async () => {
    managed.name = undefined
    const title = mock(() => {})
    const labels = mock(() => {})
    const semanticLabels = mock(() => {})
    const preTurn = mock(() => null)
    ;(sm as any).generateTitleUnlessSmallTalk = title
    ;(sm as any).applyAutoLabelMatches = labels
    ;(sm as any).applySemanticAutoLabels = semanticLabels
    ;(sm as any).startPreTurnDecisions = preTurn
    const flush = sm.flushSession.bind(sm)
    ;(sm as any).flushSession = async (id: string) => { await flush(id); allowed = false }
    await expect(send('DENIED_RAW_PHONE_SECRET')).rejects.toThrow('revoked or escalated')
    await flush(managed.id)
    expect(managed.name).toBeUndefined()
    expect(managed.autoTitle).toBeUndefined()
    expect(title).not.toHaveBeenCalled()
    expect(labels).not.toHaveBeenCalled()
    expect(semanticLabels).not.toHaveBeenCalled()
    expect(preTurn).not.toHaveBeenCalled()
    expect(readFileSync(getSessionFilePath(root, managed.id), 'utf8')).not.toContain('DENIED_RAW_PHONE_SECRET')
  })

  it('rechecks at actual chat dispatch after async agent initialization', async () => {
    const chat = mock(async function* () { yield { type: 'complete' } })
    let initialized = false
    let finalGuardCalls = 0
    ;(sm as any).getOrCreateAgent = async () => {
      initialized = true
      allowed = false
      return { getModel: () => 'claude-sonnet-4-6', setAllSources: () => {}, getSessionId: () => 'offline', chat }
    }
    await sm.sendMessage(managed.id, 'phone message', undefined, undefined, undefined, undefined, undefined, undefined, undefined, () => { if (initialized) finalGuardCalls++; authorize() }).catch(() => {})
    expect(initialized).toBe(true)
    expect(finalGuardCalls).toBe(1)
    expect(managed.messages[0]!.content).not.toContain('phone message')
    expect(chat).not.toHaveBeenCalled()
    expect(managed.isProcessing).toBe(false)
  })

  it('releases original text only at a successfully authorized chat dispatch', async () => {
    let initialized = false
    let dispatched = false
    managed.name = undefined
    const title = mock(() => {})
    const labels = mock(() => {})
    const semanticLabels = mock(() => {})
    const preTurn = mock(() => null)
    ;(sm as any).generateTitleUnlessSmallTalk = title
    ;(sm as any).applyAutoLabelMatches = labels
    ;(sm as any).applySemanticAutoLabels = semanticLabels
    ;(sm as any).startPreTurnDecisions = preTurn
    const chat = mock(async function* () { yield { type: 'complete' } })
    ;(sm as any).getOrCreateAgent = async () => {
      initialized = true
      expect(managed.messages[0]!.content).not.toContain('phone message')
      return {
        getModel: () => 'claude-sonnet-4-6', setAllSources: () => {}, getSessionId: () => 'offline',
        chat: (text: string) => {
          dispatched = true
          expect(text).toBe('phone message')
          expect(managed.messages[0]!.content).toBe('phone message')
          return chat()
        },
      }
    }
    await send()
    expect(initialized).toBe(true)
    expect(dispatched).toBe(true)
    expect(title).not.toHaveBeenCalled()
    expect(labels).not.toHaveBeenCalled()
    expect(semanticLabels).not.toHaveBeenCalled()
    expect(preTurn).not.toHaveBeenCalled()
    expect(managed.name).toBeUndefined()
    expect(managed.guardedMessageContents?.size).toBe(0)
    await (sm as any).flushSession(managed.id)
    const persisted = readFileSync(getSessionFilePath(root, managed.id), 'utf8')
    expect(persisted).toContain('phone message')
  })

  it('retains the guard on queued replay, including a merged guarded continuation', async () => {
    managed.isProcessing = true
    await send()
    const guarded = managed.messageQueue[0]!
    // An unguarded desktop message leading the merged turn must not erase the guard.
    const first = { message: 'desktop first' }
    guarded.mergeWith = first
    managed.messageQueue.unshift(first)
    allowed = false
    managed.isProcessing = false
    const chat = mock(() => {})
    ;(sm as any).getOrCreateAgent = chat
    ;(sm as any).onProcessingStopped = mock(() => {})
    ;(sm as any).processNextQueuedMessage(managed.id)
    await tick(); await tick()
    expect(chat).not.toHaveBeenCalled()
    expect(managed.messageQueue).toHaveLength(0)
  })

  it('rechecks after a deferred steering decision before redirect', async () => {
    managed.isProcessing = true
    await send()
    const payload = managed.messageQueue[0]!
    const redirect = mock(() => true)
    managed.agent = { canSteerNow: () => true, redirect } as any
    ;(sm as any).decideMidTurnDelivery = async () => { allowed = false; return 'steer' }
    await (sm as any).steerQueuedIfDecided(managed, payload, managed.messages[0], 'steer')
    expect(redirect).not.toHaveBeenCalled()
    expect(managed.messageQueue[0]).toBe(payload)
  })

  it('persists guarded queues as nonrecoverable but preserves ordinary queued recovery', async () => {
    managed.isProcessing = true
    await send()
    await sm.sendMessage(managed.id, 'desktop message')
    expect(managed.messages.map(m => m.isQueued)).toEqual([true, true])
    const stored = readFileSync(getSessionFilePath(root, managed.id), 'utf8').trim().split('\n').slice(1).map(l => JSON.parse(l))
    expect(stored.map(m => m.isQueued)).toEqual([false, true])
    expect(stored[0].content).not.toContain('phone message')
    expect(managed.messages[0]!.content).not.toContain('phone message')
    // Cold hydration cannot silently replay the device message without its callback.
    const cold = createManagedSession({ id: managed.id }, managed.workspace, { messagesLoaded: false })
    cold.isProcessing = true
    ;(sm as any).hydrateMessagesForColdPersist(cold)
    expect(cold.messageQueue.map((q: any) => q.message)).toEqual(['desktop message'])
    expect(cold.messages.some(m => m.content.includes('phone message'))).toBe(false)
  })

  it('preserves the guard on auth and source-activation automatic retries', async () => {
    managed.lastSentMessage = 'phone message'
    managed.lastSentAuthorize = authorize
    const retryGuards: Array<(() => void) | undefined> = []
    ;(sm as any).sendMessage = async (...args: any[]) => { retryGuards.push(args[9]) }
    ;(sm as any).attemptAuthRetry(managed.id, managed, managed.workspace.id)
    await tick(); await tick()
    expect(retryGuards).toEqual([authorize])
    await (sm as any).processEvent(managed, { type: 'source_activated', sourceSlug: 'github', originalMessage: 'phone message' })
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(retryGuards).toEqual([authorize, authorize])
    allowed = false
    for (const guard of retryGuards) expect(() => guard!()).toThrow('revoked or escalated')
    await (sm as any).flushSession(managed.id)
  })

  it('keeps guarded messages out of backend steering buffers even when steering is enabled', async () => {
    spyOn(backendFactory, 'resolveSessionConnection').mockReturnValue({ providerType: 'pi', midStreamBehavior: 'steer' } as any)
    managed.isProcessing = true
    const redirect = mock(() => true)
    managed.agent = { redirect, takePendingSteers: () => [] } as any
    await send()
    expect(redirect).not.toHaveBeenCalled()
    expect(managed.messageQueue[0]!.authorize).toBe(authorize)
    expect(managed.messages[0]!.content).not.toContain('phone message')
  })
})
