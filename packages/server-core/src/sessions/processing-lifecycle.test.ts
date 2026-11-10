import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionEvent } from '@craft-agent/shared/protocol'
import { Renderer } from '../../../messaging-gateway/src/renderer.ts'
import { DEFAULT_BINDING_CONFIG, type PlatformAdapter, type ChannelBinding } from '../../../messaging-gateway/src/types.ts'
import { SessionManager, createManagedSession } from './SessionManager.ts'

// Exercise the real host send/queue/replay and setup-failure paths. No backend,
// credentials or network: a gated async iterator stands in for silent reasoning.
describe('processing lifecycle → Telegram progress', () => {
  let root: string
  let sm: SessionManager
  let renderer: Renderer
  let events: SessionEvent[]
  let typing: number
  let completed: ReturnType<typeof Promise.withResolvers<void>>
  let managed: ReturnType<typeof createManagedSession>

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sm-processing-'))
    sm = new SessionManager()
    renderer = new Renderer()
    events = []
    typing = 0
    completed = Promise.withResolvers<void>()
    const workspace = { id: 'ws', name: 'Test', rootPath: root, createdAt: 1 }
    managed = createManagedSession({ id: 'session', name: 'Test' }, workspace as never, { messagesLoaded: true })
    managed.sdkSessionId = 'offline-sdk'
    ;(sm as any).sessions.set(managed.id, managed)
    ;(sm as any).decisionFeatureActive = () => false
    ;(sm as any).persistSession = () => {}
    ;(sm as any).flushSession = async () => {}
    ;(sm as any).keepBackgroundTasksAlive = true
    const binding: ChannelBinding = {
      id: 'binding', sessionId: managed.id, workspaceId: 'ws', platform: 'telegram',
      channelId: 'chat', enabled: true, createdAt: 1, config: { ...DEFAULT_BINDING_CONFIG },
    }
    const adapter = {
      platform: 'telegram', isConnected: () => true,
      capabilities: { messageEditing: true, maxMessageLength: 4096 },
      sendTyping: async () => { typing++ },
      sendText: async () => ({ platform: 'telegram', channelId: 'chat', messageId: 'error' }),
    } as unknown as PlatformAdapter
    sm.setEventSink((_channel, _target, event: SessionEvent) => {
      events.push(event)
      void renderer.handle(event, binding, adapter)
      if (event.type === 'complete') completed.resolve()
    })
  })

  afterEach(() => {
    renderer.dispose()
    rmSync(root, { recursive: true, force: true })
  })

  const transitions = (events: SessionEvent[]) => events
    .filter(e => e.type === 'processing_changed')
    .map(e => e.isProcessing)

  function silentAgent() {
    const started = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
    const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
    let turn = 0
    const agent = {
      getModel: () => 'claude-sonnet-4-6',
      setAllSources: () => {},
      getSessionId: () => 'offline-sdk',
      chat: async function* () {
        const index = turn++
        started[index]!.resolve()
        await gates[index]!.promise
        yield { type: 'complete' }
      },
    }
    ;(sm as any).getOrCreateAgent = async () => agent
    return { started, gates }
  }

  it('starts before agent setup and before the first iterator event', async () => {
    const agent = silentAgent()
    const setupEntered = Promise.withResolvers<void>()
    const setup = Promise.withResolvers<void>()
    const getAgent = (sm as any).getOrCreateAgent
    ;(sm as any).getOrCreateAgent = async () => {
      setupEntered.resolve()
      await setup.promise
      return getAgent()
    }
    const sending = sm.sendMessage(managed.id, 'think silently', undefined, undefined, { hidden: true })
    await setupEntered.promise
    expect(managed.isProcessing).toBe(true)
    expect(transitions(events)).toEqual([true])
    expect(typing).toBe(1)
    expect(events.some(e => ['text_delta', 'text_complete', 'tool_start', 'tool_result'].includes(e.type))).toBe(false)
    setup.resolve()
    await agent.started[0]!.promise
    expect(typing).toBe(1)
    agent.gates[0]!.resolve()
    await sending
    await completed.promise
    expect(transitions(events)).toEqual([true, false])
  })

  it('queued arrival adds no start; real queue replay owns a new silent turn', async () => {
    const agent = silentAgent()
    const sending = sm.sendMessage(managed.id, 'first', undefined, undefined, { hidden: true })
    await agent.started[0]!.promise
    // Semantic options force the normal host queue, independent of connection settings.
    await sm.sendMessage(managed.id, 'second', undefined, undefined, { hidden: true })
    expect(events.some(e => e.type === 'user_message' && e.status === 'queued')).toBe(true)
    expect(managed.messageQueue).toHaveLength(1)
    expect(transitions(events)).toEqual([true])
    expect(typing).toBe(1)

    agent.gates[0]!.resolve()
    await sending
    await agent.started[1]!.promise // actual processNextQueuedMessage → sendMessage
    expect(transitions(events)).toEqual([true, false, true])
    expect(typing).toBe(2)
    expect(managed.isProcessing).toBe(true)
    expect(managed.messageQueue).toHaveLength(0)
    expect(events.some(e => e.type === 'complete')).toBe(false)
    agent.gates[1]!.resolve()
    await completed.promise
    expect(transitions(events)).toEqual([true, false, true, false])
  })

  it('agent setup failure before chat still emits stop and session complete', async () => {
    ;(sm as any).getOrCreateAgent = async () => { throw new Error('offline setup failed') }
    await sm.sendMessage(managed.id, 'first', undefined, undefined, { hidden: true })
    await completed.promise
    expect(transitions(events)).toEqual([true, false])
    expect(events.some(e => e.type === 'error')).toBe(true)
    expect(managed.isProcessing).toBe(false)
    expect(typing).toBe(1)
  })

  it.each([1, 2])('old stop cleanup cannot complete/unbind/dispose a replacement after browser await %s', async gateOn => {
    const agent = silentAgent()
    const cleanupEntered = Promise.withResolvers<void>()
    const cleanupGate = Promise.withResolvers<void>()
    let clears = 0
    let unbinds = 0
    let disposals = 0
    ;(sm as any).getBrowserPaneManagerForSession = () => ({
      clearVisualsForSession: async () => {
        if (++clears === gateOn) { cleanupEntered.resolve(); await cleanupGate.promise }
      },
      unbindAllForSession: () => { unbinds++ },
    })
    ;(sm as any).disposeManagedAgentRuntime = async () => { disposals++ }
    const stop = (sm as any).onProcessingStopped.bind(sm)
    let cleanup: Promise<void> | undefined
    ;(sm as any).onProcessingStopped = (...args: unknown[]) => (cleanup = stop(...args))
    const first = sm.sendMessage(managed.id, 'first', undefined, undefined, { hidden: true })
    await agent.started[0]!.promise
    agent.gates[0]!.resolve()
    await cleanupEntered.promise
    await first
    const oldCleanup = cleanup!
    const second = sm.sendMessage(managed.id, 'replacement', undefined, undefined, { hidden: true })
    await agent.started[1]!.promise
    cleanupGate.resolve()
    await oldCleanup
    expect(transitions(events)).toEqual([true, false, true])
    expect(events.some(e => e.type === 'complete')).toBe(false)
    expect(managed.isProcessing).toBe(true)
    expect((renderer as any).states.get('binding').typingActive).toBe(true)
    expect(unbinds).toBe(0)
    expect(disposals).toBe(0)
    agent.gates[1]!.resolve()
    await second
    await completed.promise
    await cleanup
    expect(transitions(events)).toEqual([true, false, true, false])
    expect(disposals).toBe(1)
  })

  it('old cleanup cannot complete or unbind a different session object reusing the ID', async () => {
    const entered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    let unbinds = 0
    ;(sm as any).getBrowserPaneManagerForSession = () => ({
      clearVisualsForSession: async () => { entered.resolve(); await gate.promise },
      unbindAllForSession: () => { unbinds++ },
    })
    ;(sm as any).setProcessing(managed, true)
    const cleanup = (sm as any).onProcessingStopped(managed.id, 'complete')
    await entered.promise
    const replacement = createManagedSession({ id: managed.id, name: 'Replacement' }, managed.workspace, { messagesLoaded: true })
    ;(sm as any).sessions.set(managed.id, replacement)
    gate.resolve()
    await cleanup
    expect(events.some(e => e.type === 'complete')).toBe(false)
    expect(unbinds).toBe(0)
  })

  it('plan handoff awaiting browser release cannot complete or unbind a fast accepted turn', async () => {
    const agent = silentAgent()
    const cleanupEntered = Promise.withResolvers<void>()
    const cleanupGate = Promise.withResolvers<void>()
    let firstClear = true
    let unbinds = 0
    ;(sm as any).getBrowserPaneManagerForSession = () => ({
      clearVisualsForSession: async () => {
        if (firstClear) { firstClear = false; cleanupEntered.resolve(); await cleanupGate.promise }
      },
      unbindAllForSession: () => { unbinds++ },
    })
    // The real plan callback uses this agent handle to pause the old iterator.
    managed.agent = { interruptForHandoff: () => {} } as any
    ;(sm as any).disposeManagedAgentRuntime = async () => {}
    const first = sm.sendMessage(managed.id, 'make plan', undefined, undefined, { hidden: true })
    await agent.started[0]!.promise
    const planPath = join(root, 'plan.md')
    writeFileSync(planPath, '# Plan\nDo the work')
    const handoff = (sm as any).handlePlanSubmitted(managed, planPath)
    await cleanupEntered.promise
    expect(events.some(e => e.type === 'plan_submitted')).toBe(true)
    const second = sm.sendMessage(managed.id, 'accept plan', undefined, undefined, { hidden: true })
    await agent.started[1]!.promise
    cleanupGate.resolve()
    await handoff
    expect(transitions(events)).toEqual([true, false, true])
    expect(events.some(e => e.type === 'complete')).toBe(false)
    expect(unbinds).toBe(0)
    expect(managed.isProcessing).toBe(true)
    expect((renderer as any).states.get('binding').typingActive).toBe(true)
    agent.gates[0]!.resolve()
    await first
    agent.gates[1]!.resolve()
    await second
    await completed.promise
  })

  it('plan handoff with no replacement still completes and releases ownership', async () => {
    const planPath = join(root, 'normal-plan.md')
    writeFileSync(planPath, '# Plan')
    let unbinds = 0
    ;(sm as any).getBrowserPaneManagerForSession = () => ({ clearVisualsForSession: async () => {}, unbindAllForSession: () => { unbinds++ } })
    managed.agent = { interruptForHandoff: () => {} } as any
    managed.processingGeneration = 1
    ;(sm as any).setProcessing(managed, true)
    await (sm as any).handlePlanSubmitted(managed, planPath)
    expect(transitions(events)).toEqual([true, false])
    expect(events.some(e => e.type === 'complete')).toBe(true)
    expect(unbinds).toBe(1)
    expect((renderer as any).states.get('binding').typingActive).toBe(false)
  })

  it('central setter deduplicates transitions', () => {
    for (const processing of [false, true, true, false, false]) (sm as any).setProcessing(managed, processing)
    expect(transitions(events)).toEqual([true, false])
    expect(typing).toBe(1)
  })

  it.each(['complete', 'error'])('stale old iterator %s cannot stop a replacement silent turn', async terminal => {
    const agent = silentAgent()
    const first = sm.sendMessage(managed.id, 'first', undefined, undefined, { hidden: true })
    await agent.started[0]!.promise
    // Same centralized transition used by plan/auth handoff callbacks.
    ;(sm as any).setProcessing(managed, false)
    const second = sm.sendMessage(managed.id, 'replacement', undefined, undefined, { hidden: true })
    await agent.started[1]!.promise
    // An old iterator can settle after the new turn is already running.
    if (terminal === 'error') {
      // Replace the old gate's resolution with a rejection to exercise catch's generation guard.
      agent.gates[0]!.reject(new Error('old iterator failed'))
    } else agent.gates[0]!.resolve()
    await first
    expect(managed.isProcessing).toBe(true)
    expect(transitions(events)).toEqual([true, false, true])
    expect(typing).toBe(2)
    agent.gates[1]!.resolve()
    await second
    await completed.promise
    expect(transitions(events)).toEqual([true, false, true, false])
  })
})
