import { describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import { groupMessagesByTurn } from '@craft-agent/ui/chat/turn-utils'
import type { Session } from '../../../shared/types'
import { processEvent } from '../../event-processor/processor'
import type { SessionState } from '../../event-processor/types'
import { makeSpeedMismatchEvents, STANDARD_MISMATCH_USAGE, SYNTHETIC_SPEED_MISMATCH } from '../../playground/fixtures/openai-speed-accounting'
import { getContextDisplay } from '../../components/app-shell/input/context-display'
import { initializeSessionsAtom, sessionAtomFamily, sessionMetaMapAtom, updateSessionAtom } from '../sessions'

const started: Session = {
  id: 'offline-mismatch', workspaceId: 'synthetic', workspaceName: 'Synthetic — no provider calls',
  isProcessing: true, lastMessageAt: 0, model: 'pi/gpt-6.2-sol', llmConnection: 'synthetic-openai',
  openAISpeed: 'ultrafast', messages: [],
  tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
}

function expectRetainedAccounting(session: Session) {
  expect(session.tokenUsage).toMatchObject(STANDARD_MISMATCH_USAGE)
  expect(session.tokenUsage?.inputTokens).toBe(6714)
  expect(session.tokenUsage?.outputTokens).toBe(14)
  expect(session.tokenUsage?.totalTokens).toBe(6728)
  expect(session.tokenUsage?.costUsd).toBeCloseTo(6714 * 2 / 1_000_000 + 14 * 10 / 1_000_000, 12)
  expect(session.tokenUsage?.costUsd).not.toBeCloseTo(0.013568 * 3, 8)
  expect(session.tokenUsage?.costUsd).not.toBeCloseTo(0.013568 * 6, 8)
  expect(session.openAISpeed).toBe('ultrafast')
  expect(session.isProcessing).toBe(false)
  expect(session.messages).toHaveLength(1)
  expect(session.messages[0]).toMatchObject({ role: 'error', content: SYNTHETIC_SPEED_MISMATCH })
  expect(session.messages.some(message => message.role === 'assistant')).toBe(false)
  const turns = groupMessagesByTurn(session.messages)
  expect(turns).toHaveLength(1)
  expect(turns[0]?.type).toBe('system')
  expect(session.tokenUsage?.contextUsage?.usedTokens).toBe(11000)
  expect(getContextDisplay({
    inputTokens: session.tokenUsage?.inputTokens,
    contextUsage: session.tokenUsage?.contextUsage,
  })).toMatchObject({ visible: true, usedTokens: 11000 })
}

describe('offline requested-Ultrafast/default-tier error accounting', () => {
  it('retains actual usage after error+complete without creating a successful assistant turn', () => {
    const store = createStore()
    store.set(initializeSessionsAtom, [started])
    const [error, complete] = makeSpeedMismatchEvents(started.id)
    const failed = processEvent({ session: started, streaming: null }, error!)
    expect(failed.state.session.tokenUsage?.inputTokens).toBe(0)
    expect(failed.state.session.openAISpeed).toBe('ultrafast')
    const finished = processEvent(failed.state, complete!)
    store.set(updateSessionAtom, started.id, () => finished.state.session)
    expectRetainedAccounting(store.get(sessionAtomFamily(started.id))!)
    expect(store.get(sessionMetaMapAtom).get(started.id)?.tokenUsage).toMatchObject(STANDARD_MISMATCH_USAGE)
    expect(store.get(sessionMetaMapAtom).get(started.id)?.openAISpeed).toBe('ultrafast')
  })

  it('preserves native occupancy when an error completion supplies consumed usage but omits a fresh snapshot', () => {
    const nativeStarted: Session = {
      ...started,
      tokenUsage: { ...started.tokenUsage!, contextUsage: { ...STANDARD_MISMATCH_USAGE.contextUsage! } },
    }
    const events = makeSpeedMismatchEvents(started.id).map(event => event.type === 'complete'
      ? { ...event, tokenUsage: { ...event.tokenUsage!, contextUsage: undefined } }
      : event)
    const finished = events.reduce<SessionState>(
      (state, event) => processEvent(state, event).state,
      { session: nativeStarted, streaming: null },
    )
    expectRetainedAccounting(finished.session)
  })

  it('rehydrates serialized saved accounting through the real session initializer', () => {
    const finished = makeSpeedMismatchEvents(started.id).reduce<SessionState>(
      (state, event) => processEvent(state, event).state,
      { session: started, streaming: null },
    )
    const savedSnapshot = JSON.stringify(finished.session)
    const saved = JSON.parse(savedSnapshot) as Session
    const reloadedStore = createStore()
    reloadedStore.set(initializeSessionsAtom, [saved])
    const reloaded = reloadedStore.get(sessionAtomFamily(started.id))!
    expectRetainedAccounting(reloaded)
    expect(reloaded).not.toBe(finished.session)
    expect(reloadedStore.get(sessionMetaMapAtom).get(started.id)?.tokenUsage).toMatchObject(STANDARD_MISMATCH_USAGE)
    expect(reloadedStore.get(sessionMetaMapAtom).get(started.id)?.openAISpeed).toBe('ultrafast')
    expect(reloadedStore.get(sessionMetaMapAtom).get(started.id)?.messageCount).toBe(1)
  })
})
