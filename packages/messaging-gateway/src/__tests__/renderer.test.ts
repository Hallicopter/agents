/**
 * Renderer tests — covers the three response modes.
 *
 *   - `streaming`: legacy behaviour, each text_complete finalises its own
 *     message; backwards-compatibility target.
 *   - `progress`: new default; single evolving message per run, intermediate
 *     text dropped, tool status reflected in-place.
 *   - `final_only`: silent until `complete`; single send with accumulated
 *     final text, no send if buffer is empty.
 *
 * Permissions and errors are mode-agnostic and tested separately.
 */

import { afterEach, beforeEach, describe, expect, it, jest, spyOn } from 'bun:test'
import { Renderer, type SessionEvent } from '../renderer'
import {
  DEFAULT_BINDING_CONFIG,
  type AdapterCapabilities,
  type ChannelBinding,
  type PlatformAdapter,
  type PlatformType,
  type SentMessage,
  type BindingConfig,
  type ResponseMode,
} from '../types'

// ---------------------------------------------------------------------------
// Fake adapter
// ---------------------------------------------------------------------------

interface Call {
  kind: 'sendText' | 'editMessage' | 'sendButtons' | 'sendTyping'
  channelId: string
  messageId?: string
  text?: string
}

function makeAdapter(
  capabilities: Partial<AdapterCapabilities> = {},
  platform: PlatformType = 'telegram',
): PlatformAdapter & { calls: Call[] } {
  const calls: Call[] = []
  let nextId = 1

  const caps: AdapterCapabilities = {
    messageEditing: true,
    inlineButtons: true,
    maxButtons: 3,
    maxMessageLength: 4096,
    markdown: 'v2',
    webhookSupport: false,
    ...capabilities,
  }

  const adapter: PlatformAdapter & { calls: Call[] } = {
    platform,
    capabilities: caps,
    calls,
    async initialize() {},
    async destroy() {},
    isConnected() {
      return true
    },
    onMessage() {},
    onButtonPress() {},
    async sendText(channelId: string, text: string): Promise<SentMessage> {
      const messageId = String(nextId++)
      calls.push({ kind: 'sendText', channelId, text, messageId })
      return { platform, channelId, messageId }
    },
    async editMessage(channelId: string, messageId: string, text: string): Promise<void> {
      calls.push({ kind: 'editMessage', channelId, messageId, text })
    },
    async sendButtons(channelId: string, text: string): Promise<SentMessage> {
      const messageId = String(nextId++)
      calls.push({ kind: 'sendButtons', channelId, text, messageId })
      return { platform, channelId, messageId }
    },
    async sendTyping(channelId: string): Promise<void> {
      calls.push({ kind: 'sendTyping', channelId })
    },
    async sendFile(channelId: string): Promise<SentMessage> {
      const messageId = String(nextId++)
      return { platform, channelId, messageId }
    },
  }

  return adapter
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeBinding(
  overrides: Partial<BindingConfig> = {},
  platform: PlatformType = 'telegram',
): ChannelBinding {
  return {
    id: 'bind-1',
    workspaceId: 'ws-1',
    sessionId: 'sess-1',
    platform,
    channelId: 'chan-1',
    enabled: true,
    createdAt: Date.now(),
    config: { ...DEFAULT_BINDING_CONFIG, ...overrides },
  }
}

async function play(
  renderer: Renderer,
  binding: ChannelBinding,
  adapter: PlatformAdapter,
  events: SessionEvent[],
): Promise<void> {
  for (const ev of events) {
    await renderer.handle(ev, binding, adapter)
  }
}

const ev = {
  processing: (isProcessing: boolean): SessionEvent => ({ type: 'processing_changed', sessionId: 's', isProcessing }),
  delta: (s: string, turnId?: string): SessionEvent => ({
    type: 'text_delta',
    sessionId: 's',
    delta: s,
    ...(turnId ? { turnId } : {}),
  }),
  discard: (turnId: string): SessionEvent => ({
    type: 'text_discard',
    sessionId: 's',
    turnId,
  }),
  retryBackoff: (message: string): SessionEvent => ({
    type: 'retry',
    sessionId: 's',
    phase: 'backoff',
    message,
  }),
  retryActive: (): SessionEvent => ({ type: 'retry', sessionId: 's', phase: 'active' }),
  retryEnd: (): SessionEvent => ({ type: 'retry', sessionId: 's', phase: 'end' }),
  intermediate: (text: string): SessionEvent => ({
    type: 'text_complete',
    sessionId: 's',
    text,
    isIntermediate: true,
  }),
  final: (text: string): SessionEvent => ({
    type: 'text_complete',
    sessionId: 's',
    text,
    isIntermediate: false,
  }),
  // text_complete without an explicit isIntermediate flag — simulates
  // backends that don't set the field (older events or non-Claude agents).
  completeText: (text: string, turnId?: string): SessionEvent => ({
    type: 'text_complete',
    sessionId: 's',
    text,
    ...(turnId ? { turnId } : {}),
  }),
  toolStart: (displayName?: string): SessionEvent => ({
    type: 'tool_start',
    sessionId: 's',
    toolName: 'read',
    toolUseId: 'u1',
    toolInput: {},
    toolDisplayName: displayName,
  }),
  toolResult: (): SessionEvent => ({
    type: 'tool_result',
    sessionId: 's',
    toolUseId: 'u1',
    toolName: 'read',
    result: 'ok',
  }),
  complete: (): SessionEvent => ({ type: 'complete', sessionId: 's' }),
}

// ---------------------------------------------------------------------------
// progress mode (default)
// ---------------------------------------------------------------------------

describe('Renderer — progress mode, non-Telegram (bubble behaviour preserved)', () => {
  let renderer: Renderer
  beforeEach(() => {
    renderer = new Renderer()
  })

  it('happy path: tool run → evolving bubble → final text edit', async () => {
    const adapter = makeAdapter({}, 'lark')
    const binding = makeBinding({}, 'lark') // default = progress
    await play(renderer, binding, adapter, [
      ev.toolStart('Read'),
      ev.toolResult(),
      ev.final('The answer is 42.'),
      ev.complete(),
    ])

    // Exactly one send (the initial bubble) + edits for status transitions + final.
    const sends = adapter.calls.filter((c) => c.kind === 'sendText')
    expect(sends.length).toBe(1)
    expect(sends[0]!.text).toBe('🔧 Read…')

    const edits = adapter.calls.filter((c) => c.kind === 'editMessage')
    // tool_result → '💭 thinking…', then complete → final text.
    expect(edits.map((e) => e.text)).toEqual(['💭 thinking…', 'The answer is 42.'])
  })

  it('text-only run: one send + one edit with final', async () => {
    const adapter = makeAdapter({}, 'lark')
    const binding = makeBinding({}, 'lark')
    await play(renderer, binding, adapter, [
      ev.delta('hello '),
      ev.delta('world'),
      ev.final('hello world'),
      ev.complete(),
    ])

    const sends = adapter.calls.filter((c) => c.kind === 'sendText')
    const edits = adapter.calls.filter((c) => c.kind === 'editMessage')
    expect(sends.length).toBe(1)
    expect(sends[0]!.text).toBe('💭 thinking…')
    expect(edits.length).toBe(1)
    expect(edits[0]!.text).toBe('hello world')
  })

  it('drops intermediate text — never appears in any message', async () => {
    const adapter = makeAdapter({}, 'lark')
    const binding = makeBinding({}, 'lark')
    await play(renderer, binding, adapter, [
      ev.intermediate('I am thinking about the question'),
      ev.toolStart('Read'),
      ev.toolResult(),
      ev.final('Final: 42'),
      ev.complete(),
    ])

    const all = adapter.calls
      .filter((c) => c.kind === 'sendText' || c.kind === 'editMessage')
      .map((c) => c.text ?? '')
    expect(all.some((t) => t.includes('I am thinking'))).toBe(false)
    expect(all.some((t) => t.includes('Final: 42'))).toBe(true)
  })

  it('degrades to single send on complete for adapters without edit support', async () => {
    const adapter = makeAdapter({ messageEditing: false }, 'whatsapp')
    const binding = makeBinding({}, 'whatsapp')
    await play(renderer, binding, adapter, [
      ev.toolStart('Read'),
      ev.toolResult(),
      ev.final('The answer is 42.'),
      ev.complete(),
    ])

    const sends = adapter.calls.filter((c) => c.kind === 'sendText')
    const edits = adapter.calls.filter((c) => c.kind === 'editMessage')
    // Bubble is posted (status only, cannot edit) + one final send via complete.
    expect(edits.length).toBe(0)
    expect(sends.map((s) => s.text)).toEqual(['🔧 Read…', 'The answer is 42.'])
  })

  it('tool-terminated run with no non-intermediate final → falls back to last assistant text', async () => {
    const adapter = makeAdapter({}, 'lark')
    const binding = makeBinding({}, 'lark')
    // Automation pattern: agent narrates, calls a tool to deliver its result,
    // and never emits a clean non-intermediate final text_complete.
    await play(renderer, binding, adapter, [
      ev.intermediate('Sending the report now.'),
      ev.toolStart('SendTelegram'),
      ev.toolResult(),
      ev.complete(),
    ])

    const edits = adapter.calls.filter((c) => c.kind === 'editMessage')
    // Must NOT be left frozen on a status label; the last assistant text wins.
    expect(edits.at(-1)!.text).toBe('Sending the report now.')
    expect(edits.some((e) => e.text === '💭 thinking…')).toBe(true)
  })

  it('still leaves status in place when the run produced no assistant text at all', async () => {
    const adapter = makeAdapter({}, 'lark')
    const binding = makeBinding({}, 'lark')
    await play(renderer, binding, adapter, [
      ev.toolStart('Read'),
      ev.toolResult(),
      ev.complete(),
    ])
    const all = adapter.calls
      .filter((c) => c.kind === 'sendText' || c.kind === 'editMessage')
      .map((c) => c.text ?? '')
    // No empty-string edit on complete (would trip Telegram "not modified").
    expect(all.every((t) => t.length > 0)).toBe(true)
  })

  it('collapses redundant status edits (same status twice = one edit total)', async () => {
    const adapter = makeAdapter({}, 'lark')
    const binding = makeBinding({}, 'lark')
    await play(renderer, binding, adapter, [
      ev.toolStart('Read'),
      ev.toolResult(),
      ev.toolResult(), // duplicate → should NOT emit a second edit to thinking
      ev.final('done'),
      ev.complete(),
    ])

    const edits = adapter.calls.filter((c) => c.kind === 'editMessage')
    // thinking (from first tool_result) + final (from complete) = 2
    expect(edits.length).toBe(2)
    expect(edits[0]!.text).toBe('💭 thinking…')
    expect(edits[1]!.text).toBe('done')
  })
})

// ---------------------------------------------------------------------------
// progress mode — Telegram native typing (no posted status bubbles)
// ---------------------------------------------------------------------------

describe('Renderer — progress mode, Telegram native typing', () => {
  let renderer: Renderer
  beforeEach(() => {
    jest.useFakeTimers()
    renderer = new Renderer()
  })
  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  const typingCalls = (adapter: ReturnType<typeof makeAdapter>) =>
    adapter.calls.filter((c) => c.kind === 'sendTyping')
  const textCalls = (adapter: ReturnType<typeof makeAdapter>) =>
    adapter.calls.filter((c) => c.kind === 'sendText' || c.kind === 'editMessage')

  it('starts at processing ownership before any text/tool event, including a silent empty run', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding()
    await renderer.handle(ev.processing(true), binding, adapter)
    expect(typingCalls(adapter)).toHaveLength(1)
    jest.advanceTimersByTime(12_000)
    expect(typingCalls(adapter)).toHaveLength(4)
    expect(textCalls(adapter)).toHaveLength(0)

    await play(renderer, binding, adapter, [ev.processing(false), ev.complete()])
    jest.advanceTimersByTime(20_000)
    expect(typingCalls(adapter)).toHaveLength(4)
    expect(textCalls(adapter)).toHaveLength(0)
  })

  it('does not treat accepted/queued/replay notifications as running; false/true owns the timer', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding()
    const queued = (status: string): SessionEvent => ({ type: 'user_message', sessionId: 's', status })
    await play(renderer, binding, adapter, [queued('accepted'), queued('queued'), queued('processing')])
    jest.advanceTimersByTime(8000)
    expect(typingCalls(adapter)).toHaveLength(0)
    await play(renderer, binding, adapter, [ev.processing(true), queued('queued'), ev.processing(true)])
    expect(typingCalls(adapter)).toHaveLength(1)
    await play(renderer, binding, adapter, [ev.processing(false), queued('processing'), ev.delta('late')])
    jest.advanceTimersByTime(8000)
    expect(typingCalls(adapter)).toHaveLength(1)
    await renderer.handle(ev.processing(true), binding, adapter)
    jest.advanceTimersByTime(4000)
    expect(typingCalls(adapter)).toHaveLength(3)
    expect(textCalls(adapter)).toHaveLength(0)
  })

  it('preserves final text across processing stop and sends exactly once at complete', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding()
    await play(renderer, binding, adapter, [ev.processing(true), ev.final('answer'), ev.processing(false)])
    expect(textCalls(adapter)).toHaveLength(0)
    jest.advanceTimersByTime(8000)
    expect(typingCalls(adapter)).toHaveLength(1)
    await play(renderer, binding, adapter, [ev.complete(), ev.complete(), ev.delta('late')])
    jest.advanceTimersByTime(8000)
    expect(typingCalls(adapter)).toHaveLength(1)
    expect(textCalls(adapter).map(c => c.text)).toEqual(['answer'])
  })

  it.each(['permission_request', 'credential_request', 'plan_submitted'])(
    'duplicate lifecycle start and queued arrival do not resume a %s wait', async type => {
      const adapter = makeAdapter()
      const binding = makeBinding()
      await renderer.handle(ev.processing(true), binding, adapter)
      await renderer.handle({ type, sessionId: 's', request: { requestId: 'r', toolName: 'bash', description: 'test' }, message: { content: 'Plan' } }, binding, adapter)
      await play(renderer, binding, adapter, [ev.processing(true), { type: 'user_message', sessionId: 's', status: 'queued' }])
      jest.advanceTimersByTime(12_000)
      expect(typingCalls(adapter)).toHaveLength(1)
    },
  )

  it('stale wait callback cannot clear a resumed timer or create a duplicate loop', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding()
    const timerSpy = spyOn(globalThis, 'setTimeout')
    try {
      await renderer.handle(ev.processing(true), binding, adapter)
      const staleTick = timerSpy.mock.calls[0]![0] as () => void
      await renderer.handle({ type: 'credential_request', sessionId: 's' }, binding, adapter)
      // A handoff ends the old turn; approval starts a new one.
      await play(renderer, binding, adapter, [ev.processing(false), ev.processing(true)])
      expect(typingCalls(adapter)).toHaveLength(2)
      staleTick() // callback already dispatched before its timeout was cleared
      await renderer.handle(ev.delta('x'), binding, adapter)
      expect(typingCalls(adapter)).toHaveLength(2)
      jest.advanceTimersByTime(4000)
      expect(typingCalls(adapter)).toHaveLength(3)
      await renderer.handle(ev.complete(), binding, adapter)
      staleTick()
      jest.advanceTimersByTime(8000)
      expect(typingCalls(adapter)).toHaveLength(3)
    } finally {
      timerSpy.mockRestore()
    }
  })

  it.each(['error', 'typed_error'])('stops before a deferred %s send, without clobbering a newer run', async type => {
    const adapter = makeAdapter()
    const binding = makeBinding()
    const delivered = Promise.withResolvers<SentMessage>()
    adapter.sendText = () => delivered.promise
    await renderer.handle(ev.processing(true), binding, adapter)
    const reporting = renderer.handle({ type, sessionId: 's', error: 'boom' }, binding, adapter)
    jest.advanceTimersByTime(8000)
    expect(typingCalls(adapter)).toHaveLength(1)
    await renderer.handle(ev.processing(true), binding, adapter)
    delivered.resolve({ platform: 'telegram', channelId: binding.channelId, messageId: 'err' })
    await reporting
    jest.advanceTimersByTime(4000)
    expect(typingCalls(adapter)).toHaveLength(3)
  })

  it('failed error delivery cannot leave a typing timer alive', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding()
    await renderer.handle(ev.processing(true), binding, adapter)
    adapter.sendText = async () => { throw new Error('offline') }
    await expect(renderer.handle({ type: 'error', sessionId: 's', error: 'boom' }, binding, adapter)).rejects.toThrow('offline')
    jest.advanceTimersByTime(12_000)
    expect(typingCalls(adapter)).toHaveLength(1)
  })

  it('a pending typing send resolving after stop does not reschedule activity', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding()
    const sent = Promise.withResolvers<void>()
    let attempts = 0
    adapter.sendTyping = () => { attempts++; return sent.promise }
    await renderer.handle(ev.processing(true), binding, adapter)
    await renderer.handle(ev.complete(), binding, adapter)
    sent.resolve()
    await sent.promise
    jest.advanceTimersByTime(12_000)
    expect(attempts).toBe(1)
  })

  it.each(['interrupted', 'session_deleted'])('stops a silent run at %s and ignores late activity', async type => {
    const adapter = makeAdapter()
    const binding = makeBinding()
    await renderer.handle(ev.processing(true), binding, adapter)
    await play(renderer, binding, adapter, [{ type, sessionId: 's' }, ev.delta('late'), ev.toolResult()])
    jest.advanceTimersByTime(12_000)
    expect(typingCalls(adapter)).toHaveLength(1)
    expect(textCalls(adapter)).toHaveLength(0)
  })

  it('binding removal cancels a silent run timer', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding()
    await renderer.handle(ev.processing(true), binding, adapter)
    renderer.removeBinding(binding.id)
    jest.advanceTimersByTime(12_000)
    expect(typingCalls(adapter)).toHaveLength(1)
  })

  it('does not start typing while already disconnected', async () => {
    const adapter = makeAdapter()
    adapter.isConnected = () => false
    await renderer.handle(ev.processing(true), makeBinding(), adapter)
    jest.advanceTimersByTime(12_000)
    expect(typingCalls(adapter)).toHaveLength(0)
  })

  it.each([
    ['telegram', 'streaming'], ['telegram', 'final_only'],
    ['lark', 'progress'], ['whatsapp', 'progress'],
  ] as const)('ignores processing transitions for %s / %s', async (platform, responseMode) => {
    const adapter = makeAdapter({}, platform)
    await play(renderer, makeBinding({ responseMode }, platform), adapter, [ev.processing(true), ev.processing(false)])
    jest.advanceTimersByTime(12_000)
    expect(adapter.calls).toHaveLength(0)
  })

  it('tool-only run: no status bubble, no final send, typing started then stopped', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding()
    await play(renderer, binding, adapter, [
      ev.toolStart('Read'),
      ev.toolResult(),
      ev.complete(),
    ])

    // No posted message or edit at all — the whole point of the patch.
    expect(textCalls(adapter)).toHaveLength(0)
    // Typing was shown while processing.
    expect(typingCalls(adapter).length).toBeGreaterThanOrEqual(1)

    // After completion, no further typing refreshes fire.
    const before = typingCalls(adapter).length
    jest.advanceTimersByTime(20_000)
    expect(typingCalls(adapter).length).toBe(before)
  })

  it('intermediate-only run: no sendText, no edits (no intermediate fallback)', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding()
    await play(renderer, binding, adapter, [
      ev.intermediate('Sending the report now.'),
      ev.toolStart('SendTelegram'),
      ev.toolResult(),
      ev.complete(),
    ])

    expect(textCalls(adapter)).toHaveLength(0)
  })

  it('final answer delivered exactly once, no status bubble', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding()
    await play(renderer, binding, adapter, [
      ev.toolStart('Read'),
      ev.toolResult(),
      ev.final('The answer is 42.'),
      ev.complete(),
    ])

    const sends = adapter.calls.filter((c) => c.kind === 'sendText')
    const edits = adapter.calls.filter((c) => c.kind === 'editMessage')
    expect(edits).toHaveLength(0)
    expect(sends).toHaveLength(1)
    expect(sends[0]!.text).toBe('The answer is 42.')
  })

  it('long work: typing refreshes on a bounded cadence while processing', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding()
    await play(renderer, binding, adapter, [ev.toolStart('Read')])
    expect(typingCalls(adapter)).toHaveLength(1)

    jest.advanceTimersByTime(4000)
    expect(typingCalls(adapter)).toHaveLength(2)
    jest.advanceTimersByTime(4000)
    expect(typingCalls(adapter)).toHaveLength(3)

    await play(renderer, binding, adapter, [ev.complete()])
    const afterComplete = typingCalls(adapter).length
    jest.advanceTimersByTime(20_000)
    expect(typingCalls(adapter).length).toBe(afterComplete)
  })

  it('repeated activity events do not spawn duplicate typing loops', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding()
    await play(renderer, binding, adapter, [
      ev.toolStart('Read'),
      ev.toolStart('Read'),
      ev.toolResult(),
      ev.delta('x'),
    ])
    // Only the first event starts typing; the rest are no-ops while the timer
    // is pending.
    expect(typingCalls(adapter)).toHaveLength(1)

    jest.advanceTimersByTime(4000)
    // Exactly one refresh, not one per event.
    expect(typingCalls(adapter)).toHaveLength(2)
  })

  it('stops typing on interruption and does not resurrect it', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding()
    await play(renderer, binding, adapter, [ev.toolStart('Read')])
    expect(typingCalls(adapter)).toHaveLength(1)

    await play(renderer, binding, adapter, [{ type: 'interrupted', sessionId: 's' }])
    const afterStop = typingCalls(adapter).length
    jest.advanceTimersByTime(20_000)
    expect(typingCalls(adapter).length).toBe(afterStop)
    // No message posted for a user-initiated stop.
    expect(textCalls(adapter)).toHaveLength(0)
  })

  it('stops typing on error and still surfaces the error message', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding()
    await play(renderer, binding, adapter, [
      ev.toolStart('Read'),
      { type: 'error', sessionId: 's', error: 'boom' } as SessionEvent,
    ])

    const afterError = typingCalls(adapter).length
    jest.advanceTimersByTime(20_000)
    expect(typingCalls(adapter).length).toBe(afterError)

    const sends = adapter.calls.filter((c) => c.kind === 'sendText')
    expect(sends).toHaveLength(1)
    expect(sends[0]!.text).toContain('❌')
    expect(sends[0]!.text).toContain('boom')
  })

  it('stops typing while a permission prompt is pending, then resumes on activity', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding({ approvalChannel: 'chat' })
    await play(renderer, binding, adapter, [ev.toolStart('Read')])
    expect(typingCalls(adapter)).toHaveLength(1)

    await renderer.handle(
      {
        type: 'permission_request',
        sessionId: 's',
        request: { requestId: 'r1', toolName: 'bash', description: 'run tests' },
      } as SessionEvent,
      binding,
      adapter,
    )
    const afterPrompt = typingCalls(adapter).length
    jest.advanceTimersByTime(20_000)
    expect(typingCalls(adapter).length).toBe(afterPrompt)
    // Permission prompt itself is preserved.
    expect(adapter.calls.filter((c) => c.kind === 'sendButtons')).toHaveLength(1)

    // Agent resumes after approval → typing restarts.
    await play(renderer, binding, adapter, [ev.toolResult()])
    expect(typingCalls(adapter).length).toBe(afterPrompt + 1)
  })

  it('stops typing while a credential request is pending', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding()
    await play(renderer, binding, adapter, [ev.toolStart('Read')])
    expect(typingCalls(adapter)).toHaveLength(1)

    await renderer.handle(
      {
        type: 'credential_request',
        sessionId: 's',
        request: { requestId: 'c1' },
      } as SessionEvent,
      binding,
      adapter,
    )
    const afterPrompt = typingCalls(adapter).length
    jest.advanceTimersByTime(20_000)
    expect(typingCalls(adapter).length).toBe(afterPrompt)
  })

  it('stops typing while a plan is awaiting review, then resumes on activity', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding()
    await play(renderer, binding, adapter, [ev.toolStart('Read')])
    expect(typingCalls(adapter)).toHaveLength(1)

    await renderer.handle(
      {
        type: 'plan_submitted',
        sessionId: 's',
        message: { id: 'm1', role: 'assistant', content: 'Plan' },
      } as SessionEvent,
      binding,
      adapter,
    )
    const afterPlan = typingCalls(adapter).length
    jest.advanceTimersByTime(20_000)
    expect(typingCalls(adapter).length).toBe(afterPlan)
    // The plan notice itself is still delivered.
    expect(adapter.calls.filter((c) => c.kind === 'sendText').length).toBeGreaterThanOrEqual(1)

    // Agent resumes after the plan is accepted → typing restarts.
    await play(renderer, binding, adapter, [ev.toolResult()])
    expect(typingCalls(adapter).length).toBe(afterPlan + 1)
  })

  it('concurrent complete events deliver the final exactly once (deferred send)', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding()

    const sent: string[] = []
    let release: (() => void) | null = null
    adapter.sendText = (channelId: string, text: string) => {
      sent.push(text)
      return new Promise<SentMessage>((resolve) => {
        release = () => resolve({ platform: 'telegram', channelId, messageId: 'm1' })
      })
    }

    // Accumulate the final, then fire two completes without awaiting the first
    // (mirrors the gateway's `void renderer.handle(...)` dispatch).
    await renderer.handle(ev.final('answer'), binding, adapter)
    const first = renderer.handle(ev.complete(), binding, adapter)
    const second = renderer.handle(ev.complete(), binding, adapter)

    // Only the first complete starts a send; the second sees an empty buffer.
    expect(sent).toEqual(['answer'])

    release?.()
    await Promise.all([first, second])
    expect(sent).toEqual(['answer'])
  })

  it('a deferred final send cannot stop typing or clear text for a newer run', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding()
    const sent = Promise.withResolvers<SentMessage>()
    adapter.sendText = () => sent.promise
    await play(renderer, binding, adapter, [ev.processing(true), ev.final('first'), ev.processing(false)])
    const finishing = renderer.handle(ev.complete(), binding, adapter)
    await play(renderer, binding, adapter, [ev.processing(true), ev.final('second')])
    sent.resolve({ platform: 'telegram', channelId: binding.channelId, messageId: 'first' })
    await finishing
    jest.advanceTimersByTime(4000)
    expect(typingCalls(adapter)).toHaveLength(3)
    const sends: string[] = []
    adapter.sendText = async (channelId, text) => {
      sends.push(text)
      return { platform: 'telegram', channelId, messageId: 'second' }
    }
    await play(renderer, binding, adapter, [ev.processing(false), ev.complete()])
    expect(sends).toEqual(['second'])
  })

  it('self-terminates the typing loop when the adapter disconnects', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding()
    await play(renderer, binding, adapter, [ev.toolStart('Read')])
    expect(typingCalls(adapter)).toHaveLength(1)

    // Simulate a mid-run disconnect: the gateway would now drop the eventual
    // `complete`, so the loop must stop on its own.
    adapter.isConnected = () => false
    jest.advanceTimersByTime(4000)
    const afterDisconnect = typingCalls(adapter).length
    jest.advanceTimersByTime(20_000)
    expect(typingCalls(adapter).length).toBe(afterDisconnect)
  })

  it('stops typing on shutdown (renderer.dispose)', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding()
    await play(renderer, binding, adapter, [ev.toolStart('Read')])
    expect(typingCalls(adapter)).toHaveLength(1)

    renderer.dispose()
    const afterDispose = typingCalls(adapter).length
    jest.advanceTimersByTime(20_000)
    expect(typingCalls(adapter).length).toBe(afterDispose)
  })

  it('chunks a long final answer across multiple sends', async () => {
    const adapter = makeAdapter({ maxMessageLength: 50 })
    const binding = makeBinding()
    const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
    await play(renderer, binding, adapter, [ev.final(long), ev.complete()])

    const sends = adapter.calls.filter((c) => c.kind === 'sendText')
    expect(sends.length).toBeGreaterThan(1)
    expect(sends.map((s) => s.text).join('\n')).toContain('line 19')
  })

  it('a late timer from a finished run cannot resurrect typing', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding()
    await play(renderer, binding, adapter, [ev.toolStart('Read')])
    // Complete the run (clears the timer + bumps epoch).
    await play(renderer, binding, adapter, [ev.final('done'), ev.complete()])
    const afterComplete = typingCalls(adapter).length

    // Any in-flight tick must be inert.
    jest.advanceTimersByTime(20_000)
    expect(typingCalls(adapter).length).toBe(afterComplete)
  })
})

// ---------------------------------------------------------------------------
// final_only mode
// ---------------------------------------------------------------------------

describe('Renderer — final_only mode', () => {
  let renderer: Renderer
  beforeEach(() => {
    renderer = new Renderer()
  })

  it('happy path: silent until complete, one send with concatenated final text', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding({ responseMode: 'final_only' as ResponseMode })
    await play(renderer, binding, adapter, [
      ev.toolStart('Read'),
      ev.toolResult(),
      ev.final('Part 1.'),
      ev.final('Part 2.'),
      ev.complete(),
    ])

    const sends = adapter.calls.filter((c) => c.kind === 'sendText')
    const edits = adapter.calls.filter((c) => c.kind === 'editMessage')
    expect(edits.length).toBe(0)
    expect(sends.length).toBe(1)
    expect(sends[0]!.text).toBe('Part 1.\n\nPart 2.')
  })

  it('empty completion: no send at all', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding({ responseMode: 'final_only' as ResponseMode })
    await play(renderer, binding, adapter, [ev.toolStart('Read'), ev.toolResult(), ev.complete()])
    expect(adapter.calls.length).toBe(0)
  })

  it('tool-terminated run with only intermediate text → still sends the last assistant text', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding({ responseMode: 'final_only' as ResponseMode })
    await play(renderer, binding, adapter, [
      ev.intermediate('Here is the summary you asked for.'),
      ev.toolStart('SendTelegram'),
      ev.toolResult(),
      ev.complete(),
    ])

    const sends = adapter.calls.filter((c) => c.kind === 'sendText')
    expect(sends.length).toBe(1)
    expect(sends[0]!.text).toBe('Here is the summary you asked for.')
  })

  it('non-intermediate final is preferred over earlier intermediate text', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding({ responseMode: 'final_only' as ResponseMode })
    await play(renderer, binding, adapter, [
      ev.intermediate('thinking out loud'),
      ev.final('The real answer.'),
      ev.complete(),
    ])

    const sends = adapter.calls.filter((c) => c.kind === 'sendText')
    expect(sends.length).toBe(1)
    expect(sends[0]!.text).toBe('The real answer.')
  })

  it('treats text_complete without isIntermediate as final (backwards compat)', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding({ responseMode: 'final_only' as ResponseMode })
    await play(renderer, binding, adapter, [ev.completeText('legacy-shape-text'), ev.complete()])

    const sends = adapter.calls.filter((c) => c.kind === 'sendText')
    expect(sends.length).toBe(1)
    expect(sends[0]!.text).toBe('legacy-shape-text')
  })
})

// ---------------------------------------------------------------------------
// streaming mode (legacy — regression guard)
// ---------------------------------------------------------------------------

describe('Renderer — streaming mode (legacy)', () => {
  let renderer: Renderer
  beforeEach(() => {
    jest.useFakeTimers()
    renderer = new Renderer()
  })
  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it('each text_complete finalises its own message (legacy behaviour)', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding({ responseMode: 'streaming' as ResponseMode })
    await play(renderer, binding, adapter, [
      ev.delta('first'),
      ev.completeText('first'),
      ev.delta('second'),
      ev.completeText('second'),
      ev.complete(),
    ])

    const sends = adapter.calls.filter((c) => c.kind === 'sendText')
    // Two separate messages, one per text_complete cycle.
    expect(sends.length).toBe(2)
    expect(sends[0]!.text).toBe('first')
    expect(sends[1]!.text).toBe('second')
  })

  it('drops a buffered failed attempt and sends only the recovered answer without editing', async () => {
    const adapter = makeAdapter({ messageEditing: false })
    const binding = makeBinding({ responseMode: 'streaming' as ResponseMode })

    await play(renderer, binding, adapter, [
      ev.delta('Failed ', 'attempt-0'),
      ev.delta('partial', 'attempt-0'),
      ev.discard('attempt-0'),
      ev.retryBackoff('Retrying in 2s…'),
      ev.retryActive(),
      ev.delta('Recovered ', 'attempt-1'),
      ev.delta('answer', 'attempt-1'),
      { type: 'text_complete', sessionId: 's', turnId: 'attempt-1' },
      ev.retryEnd(),
      ev.complete(),
    ])

    expect(adapter.calls.filter((call) => call.kind === 'editMessage')).toHaveLength(0)
    expect(
      adapter.calls.filter((call) => call.kind === 'sendText').map((call) => call.text),
    ).toEqual(['Recovered answer'])
  })

  it('reuses a posted partial for discard, retry status, and recovered output', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding({ responseMode: 'streaming' as ResponseMode })
    const backoff = 'Connection Error. Retrying in 2s…'

    await play(renderer, binding, adapter, [
      ev.delta('Failed', 'attempt-0'),
      ev.delta(' partial', 'attempt-0'),
      ev.discard('attempt-0'),
    ])
    // The failed attempt's scheduled edit must not reappear after discard.
    jest.advanceTimersByTime(10_000)
    await play(renderer, binding, adapter, [
      ev.retryBackoff(backoff),
      ev.retryActive(),
      ev.delta('Recovered ', 'attempt-1'),
      ev.delta('answer', 'attempt-1'),
    ])
    // A retained message ID must restart periodic editing for the recovered
    // stream rather than waiting for text_complete to replace the status.
    jest.advanceTimersByTime(10_000)
    await Promise.resolve()
    await Promise.resolve()
    await play(renderer, binding, adapter, [
      { type: 'text_complete', sessionId: 's', text: '', turnId: 'attempt-1' },
      ev.retryEnd(),
      ev.complete(),
    ])

    const sends = adapter.calls.filter((call) => call.kind === 'sendText')
    const edits = adapter.calls.filter((call) => call.kind === 'editMessage')
    expect(sends).toHaveLength(1)
    expect(sends[0]).toMatchObject({ messageId: '1', text: 'Failed' })
    expect(edits.map((call) => call.messageId)).toEqual(['1', '1', '1', '1'])
    expect(edits.map((call) => call.text)).toEqual([
      '⚠️ Incomplete response discarded.',
      backoff,
      '💭 thinking…',
      'Recovered answer',
    ])
  })

  it('ignores a stale discard and preserves completed output', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding({ responseMode: 'streaming' as ResponseMode })

    await play(renderer, binding, adapter, [
      ev.delta('Earlier partial', 'completed-turn'),
      ev.completeText('Earlier completed', 'completed-turn'),
      ev.delta('Keep this', 'current-turn'),
      ev.discard('older-turn'),
      ev.completeText('Keep this completed', 'current-turn'),
      ev.complete(),
    ])

    const sends = adapter.calls.filter((call) => call.kind === 'sendText')
    const edits = adapter.calls.filter((call) => call.kind === 'editMessage')
    expect(sends.map((call) => call.messageId)).toEqual(['1', '2'])
    expect(edits).toEqual([
      {
        kind: 'editMessage',
        channelId: 'chan-1',
        messageId: '1',
        text: 'Earlier completed',
      },
      {
        kind: 'editMessage',
        channelId: 'chan-1',
        messageId: '2',
        text: 'Keep this completed',
      },
    ])
  })

  it('replaces a running retry placeholder before surfacing terminal failure', async () => {
    const adapter = makeAdapter()
    const binding = makeBinding({ responseMode: 'streaming' as ResponseMode })

    await play(renderer, binding, adapter, [
      ev.delta('Failed partial', 'attempt-0'),
      ev.discard('attempt-0'),
      ev.retryBackoff('Retrying…'),
      ev.retryActive(),
      ev.retryEnd(),
      { type: 'error', sessionId: 's', error: 'provider unavailable' },
      ev.complete(),
    ])
    jest.advanceTimersByTime(10_000)

    const sends = adapter.calls.filter((call) => call.kind === 'sendText')
    const edits = adapter.calls.filter((call) => call.kind === 'editMessage')
    expect(edits.at(-1)).toMatchObject({
      messageId: '1',
      text: '⚠️ Incomplete response discarded.',
    })
    expect(edits.at(-1)?.text).not.toBe('💭 thinking…')
    expect(sends.at(-1)?.text).toBe('❌ provider unavailable')
  })
})

// ---------------------------------------------------------------------------
// Legacy config coercion (no responseMode field on BindingConfig)
// ---------------------------------------------------------------------------

describe('Renderer — legacy config coercion', () => {
  it('streamResponses=true with no responseMode → streaming behaviour', async () => {
    const renderer = new Renderer()
    const adapter = makeAdapter()
    const binding = makeBinding()
    // Simulate a legacy binding (responseMode field absent).
    ;(binding.config as Partial<BindingConfig>).responseMode = undefined
    binding.config.streamResponses = true

    await play(renderer, binding, adapter, [ev.completeText('hi'), ev.complete()])

    const sends = adapter.calls.filter((c) => c.kind === 'sendText')
    expect(sends.length).toBe(1)
    expect(sends[0]!.text).toBe('hi')
  })

  it('streamResponses=false with no responseMode → final_only behaviour', async () => {
    const renderer = new Renderer()
    const adapter = makeAdapter()
    const binding = makeBinding()
    ;(binding.config as Partial<BindingConfig>).responseMode = undefined
    binding.config.streamResponses = false

    await play(renderer, binding, adapter, [
      ev.toolStart('Read'),
      ev.toolResult(),
      ev.final('done'),
      ev.complete(),
    ])

    const sends = adapter.calls.filter((c) => c.kind === 'sendText')
    const edits = adapter.calls.filter((c) => c.kind === 'editMessage')
    expect(edits.length).toBe(0)
    expect(sends.length).toBe(1)
    expect(sends[0]!.text).toBe('done')
  })
})

// ---------------------------------------------------------------------------
// Permissions and errors (mode-agnostic)
// ---------------------------------------------------------------------------

describe('Renderer — permissions and errors', () => {
  it('permission_request sends buttons in chat channel', async () => {
    const renderer = new Renderer()
    const adapter = makeAdapter()
    const binding = makeBinding({ approvalChannel: 'chat' })
    await renderer.handle(
      {
        type: 'permission_request',
        sessionId: 's',
        request: {
          requestId: 'r1',
          toolName: 'bash',
          description: 'run tests',
        },
      } as SessionEvent,
      binding,
      adapter,
    )
    const buttons = adapter.calls.filter((c) => c.kind === 'sendButtons')
    expect(buttons.length).toBe(1)
  })

  it('permission_request fires recordPermissionMessage with the rendering binding, requestId, messageId', async () => {
    const recorded: Array<{ bindingId: string; sessionId: string; requestId: string; messageId: string }> = []
    const renderer = new Renderer({
      recordPermissionMessage: (b, requestId, messageId) => {
        recorded.push({
          bindingId: b.id,
          sessionId: b.sessionId,
          requestId,
          messageId,
        })
      },
    })
    const adapter = makeAdapter()
    const binding = makeBinding({ approvalChannel: 'chat' })
    await renderer.handle(
      {
        type: 'permission_request',
        sessionId: 's',
        request: {
          requestId: 'r1',
          toolName: 'bash',
          description: 'run tests',
        },
      } as SessionEvent,
      binding,
      adapter,
    )

    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.bindingId).toBe(binding.id)
    expect(recorded[0]?.sessionId).toBe(binding.sessionId)
    expect(recorded[0]?.requestId).toBe('r1')
    expect(recorded[0]?.messageId).toBeTruthy()
  })

  it('error event emits ❌ message and resets state', async () => {
    const renderer = new Renderer()
    const adapter = makeAdapter({}, 'lark')
    const binding = makeBinding({}, 'lark')
    await play(renderer, binding, adapter, [
      ev.toolStart('Read'),
      { type: 'error', sessionId: 's', error: 'boom' } as SessionEvent,
      ev.complete(), // should be a no-op after reset
    ])
    const sends = adapter.calls.filter((c) => c.kind === 'sendText')
    // First send: the progress bubble. Second send: the error message.
    expect(sends.length).toBe(2)
    expect(sends[1]!.text).toContain('❌')
    expect(sends[1]!.text).toContain('boom')
  })
})


describe('Renderer — WhatsApp desktop-only approvals', () => {
  it('permission_request on WhatsApp sends an informational desktop-only message', async () => {
    const renderer = new Renderer()
    const adapter = makeAdapter({ inlineButtons: false, messageEditing: false, markdown: 'whatsapp' })
    ;(adapter as any).platform = 'whatsapp'
    const binding = {
      ...makeBinding({ approvalChannel: 'chat' }),
      platform: 'whatsapp' as const,
      channelId: 'wa-1',
    }

    await renderer.handle(
      {
        type: 'permission_request',
        sessionId: 's',
        request: {
          requestId: 'r1',
          toolName: 'bash',
          description: 'run tests',
        },
      } as SessionEvent,
      binding,
      adapter,
    )

    expect(adapter.calls.filter((c) => c.kind === 'sendButtons')).toHaveLength(0)
    const sends = adapter.calls.filter((c) => c.kind === 'sendText')
    expect(sends).toHaveLength(1)
    expect(sends[0]!.text).toContain('desktop app')
  })

  it('plan_submitted on WhatsApp sends an informational desktop-only message', async () => {
    const renderer = new Renderer()
    const adapter = makeAdapter({ inlineButtons: false, messageEditing: false, markdown: 'whatsapp' })
    ;(adapter as any).platform = 'whatsapp'
    const binding = {
      ...makeBinding(),
      platform: 'whatsapp' as const,
      channelId: 'wa-1',
    }

    await renderer.handle(
      {
        type: 'plan_submitted',
        sessionId: 's',
        message: { id: 'm1', role: 'assistant', content: 'Plan ready' } as any,
      } as SessionEvent,
      binding,
      adapter,
    )

    const sends = adapter.calls.filter((c) => c.kind === 'sendText')
    expect(sends).toHaveLength(1)
    expect(sends[0]!.text).toContain('plan is ready')
    expect(sends[0]!.text).toContain('desktop app')
  })
})
