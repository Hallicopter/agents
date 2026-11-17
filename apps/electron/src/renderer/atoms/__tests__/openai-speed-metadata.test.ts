import { describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import type { Session } from '../../../shared/types'
import { processEvent } from '../../event-processor/processor'
import { initializeSessionsAtom, sessionAtomFamily, sessionMetaMapAtom, updateSessionAtom } from '../sessions'

const session: Session = {
  id: 'one', workspaceId: 'synthetic', workspaceName: 'Synthetic',
  isProcessing: false, lastMessageAt: 0, model: 'pi/gpt-6.2-sol', llmConnection: 'openai', messages: [],
}

describe('persisted OpenAI speed metadata in shared renderer', () => {
  it('updates the current session and metadata only after a canonical saved event', () => {
    const store = createStore()
    store.set(initializeSessionsAtom, [session, { ...session, id: 'two' }])
    let publications = 0
    store.sub(sessionMetaMapAtom, () => { publications++ })
    const before = store.get(sessionAtomFamily('one'))!
    expect(before.openAISpeed).toBeUndefined()
    const result = processEvent({ session: before, streaming: null }, {
      type: 'session_metadata_changed', sessionId: 'one', changes: { openAISpeed: 'ultrafast' },
    })
    store.set(updateSessionAtom, 'one', () => result.state.session)
    expect(store.get(sessionAtomFamily('one'))?.openAISpeed).toBe('ultrafast')
    expect(store.get(sessionMetaMapAtom).get('one')?.openAISpeed).toBe('ultrafast')
    expect(store.get(sessionAtomFamily('two'))?.openAISpeed).toBeUndefined()
    expect(result.state.session.model).toBe(session.model)
    expect(result.state.session.llmConnection).toBe(session.llmConnection)
    expect(publications).toBe(1)

    const reset = processEvent(result.state, {
      type: 'session_metadata_changed', sessionId: 'one', changes: { openAISpeed: 'standard' },
    })
    store.set(updateSessionAtom, 'one', () => reset.state.session)
    expect(store.get(sessionMetaMapAtom).get('one')?.openAISpeed).toBe('standard')
    expect(publications).toBe(2)
  })
})
