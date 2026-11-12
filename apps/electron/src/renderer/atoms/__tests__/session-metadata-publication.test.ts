import { describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import type { Session } from '../../../shared/types'
import { processEvent } from '../../event-processor/processor'
import type { AgentEvent, StreamingState } from '../../event-processor/types'
import { addSessionAtom, extractSessionMeta, initializeSessionsAtom, removeSessionAtom, sessionAtomFamily, sessionMetaMapAtom, updateSessionAtom } from '../sessions'

function fixture(): Session {
  return {
    id: 'stream', workspaceId: 'synthetic', workspaceName: 'Synthetic', name: 'Stream', isProcessing: true,
    lastFinalMessageId: 'final', lastMessageAt: 123,
    messages: [
      { id: 'final', role: 'assistant', content: 'Finished', timestamp: 100 },
      { id: 'streaming', role: 'assistant', content: '', timestamp: 123, isStreaming: true, turnId: 'turn' },
    ],
  }
}

function setup(session = fixture()) {
  const store = createStore()
  store.set(initializeSessionsAtom, [session, { ...fixture(), id: 'unrelated' }])
  let metadataNotifications = 0
  let transcriptNotifications = 0
  let unrelatedNotifications = 0
  store.sub(sessionMetaMapAtom, () => { metadataNotifications++ })
  store.sub(sessionAtomFamily(session.id), () => { transcriptNotifications++ })
  store.sub(sessionAtomFamily('unrelated'), () => { unrelatedNotifications++ })
  let streaming: StreamingState | null = null
  return {
    store,
    counts: () => ({ metadataNotifications, transcriptNotifications, unrelatedNotifications }),
    dispatch(event: AgentEvent) {
      const result = processEvent({ session: store.get(sessionAtomFamily(session.id))!, streaming }, event)
      streaming = result.state.streaming
      store.set(updateSessionAtom, session.id, () => result.state.session)
      return result
    },
  }
}

describe('session metadata publication', () => {
  it('delivers every text delta without invalidating metadata or unrelated transcripts', () => {
    const { store, counts, dispatch } = setup()
    const mapBefore = store.get(sessionMetaMapAtom)
    for (let i = 0; i < 100; i++) {
      dispatch({ type: 'text_delta', sessionId: 'stream', turnId: 'turn', delta: 'token ' })
    }
    expect(store.get(sessionAtomFamily('stream'))!.messages.at(-1)!.content).toBe('token '.repeat(100))
    expect(store.get(sessionMetaMapAtom)).toBe(mapBefore)
    expect(counts()).toEqual({ metadataNotifications: 0, transcriptNotifications: 100, unrelatedNotifications: 0 })
  })

  it('keeps tool output, final text, usage, unread, and completion correct', () => {
    const { store, counts, dispatch } = setup()
    dispatch({ type: 'tool_start', sessionId: 'stream', toolUseId: 'tool', toolName: 'Read', turnId: 'turn' })
    const mapAfterStart = store.get(sessionMetaMapAtom)
    const countAfterStart = counts().metadataNotifications
    dispatch({ type: 'tool_result', sessionId: 'stream', toolUseId: 'tool', result: 'full output', turnId: 'turn' })
    expect(store.get(sessionAtomFamily('stream'))!.messages.find(m => m.toolUseId === 'tool')?.toolResult).toBe('full output')
    expect(store.get(sessionMetaMapAtom)).toBe(mapAfterStart)
    expect(counts().metadataNotifications).toBe(countAfterStart)
    dispatch({ type: 'text_complete', sessionId: 'stream', turnId: 'turn', text: 'authoritative final', messageId: 'authoritative', timestamp: 456 })
    expect(store.get(sessionAtomFamily('stream'))!.messages.find(m => m.id === 'authoritative')?.content).toBe('authoritative final')
    const tokenUsage = { inputTokens: 10, outputTokens: 20, totalTokens: 30, costUsd: 0.1, contextTokens: 10 }
    const beforeComplete = counts().metadataNotifications
    dispatch({ type: 'complete', sessionId: 'stream', hasUnread: true, tokenUsage })
    const meta = store.get(sessionMetaMapAtom).get('stream')!
    expect(meta.isProcessing).toBe(false)
    expect(meta.hasUnread).toBe(true)
    expect(meta.tokenUsage).toEqual(tokenUsage)
    expect(meta.lastMessageAt).toBeGreaterThan(123)
    expect(counts().metadataNotifications).toBe(beforeComplete + 1)
    expect(counts().transcriptNotifications).toBe(4)
  })

  it('retains permission effects without needing a list publication', () => {
    const { counts, dispatch } = setup()
    const request = { requestId: 'permission', sessionId: 'stream', toolName: 'Bash', description: 'Synthetic approval' }
    const result = dispatch({ type: 'permission_request', sessionId: 'stream', request })
    expect(result.effects).toContainEqual({ type: 'permission_request', request })
    // The existing processor returns the same session for effects-only events.
    expect(counts().transcriptNotifications).toBe(0)
    expect(counts().metadataNotifications).toBe(0)
  })

  it('publishes first streaming-message counts and error messages, then removes lifecycle state', () => {
    const { store, counts, dispatch } = setup({ ...fixture(), messages: [] })
    dispatch({ type: 'text_delta', sessionId: 'stream', turnId: 'turn', delta: 'first token' })
    expect(store.get(sessionMetaMapAtom).get('stream')!.messageCount).toBe(1)
    dispatch({ type: 'error', sessionId: 'stream', error: 'Synthetic failure' })
    expect(store.get(sessionAtomFamily('stream'))!.messages.some(m => m.role === 'error')).toBe(true)
    expect(store.get(sessionMetaMapAtom).get('stream')).toEqual(extractSessionMeta(store.get(sessionAtomFamily('stream'))!))
    expect(counts().metadataNotifications).toBe(2)
    store.set(removeSessionAtom, 'stream')
    expect(store.get(sessionMetaMapAtom).has('stream')).toBe(false)
    expect(store.get(sessionAtomFamily('stream'))).toBeNull()
    store.set(addSessionAtom, fixture())
    expect(store.get(sessionMetaMapAtom).get('stream')).toEqual(extractSessionMeta(fixture()))
    expect(store.get(sessionAtomFamily('stream'))!.messages).toHaveLength(2)
  })

  it('publishes new sessions and preserves null update semantics', () => {
    const { store } = setup()
    store.set(updateSessionAtom, 'new', () => ({ ...fixture(), id: 'new' }))
    expect(store.get(sessionMetaMapAtom).has('new')).toBe(true)
    const before = store.get(sessionMetaMapAtom)
    store.set(updateSessionAtom, 'new', () => null)
    expect(store.get(sessionAtomFamily('new'))).toBeNull()
    // Removal is still the responsibility of removeSessionAtom, as before.
    expect(store.get(sessionMetaMapAtom)).toBe(before)
  })

  it('publishes every extracted metadata field, including future fields', () => {
    const base = {
      ...fixture(), preview: 'preview', isFlagged: false, lastReadMessageId: 'read',
      workingDirectory: '/synthetic', enabledSourceSlugs: ['source'], codingMode: false,
      sharedUrl: 'https://example.invalid', sharedId: 'share', hasUnread: false,
      labels: ['label'], permissionMode: 'ask', sessionStatus: 'todo', lastMessageRole: 'user',
      isAsyncOperationOngoing: false, isRegeneratingTitle: false, model: 'model', llmConnection: 'connection',
      tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0, contextTokens: 1 },
      createdAt: 1, messageCount: 3, hidden: false, isArchived: false, archivedAt: 1,
      projectId: 'project', parentSessionId: 'parent', branchFromSessionId: 'branch',
      kanbanColumn: 'todo', taskSlug: 'task', taskRunId: 'run', taskNodeId: 'node', taskNodeCount: 1,
      taskDraft: false, futureMetadataField: 'future',
    } as Session
    for (const [key, value] of Object.entries(extractSessionMeta(base))) {
      if (key === 'id') continue // session identity is the atom key, not mutable metadata
      const changed = typeof value === 'boolean' ? !value
        : typeof value === 'number' ? value + 1
        : typeof value === 'string' ? value + '-changed'
        : Array.isArray(value) ? [...value, 'new']
        : typeof value === 'object' ? { ...value, costUsd: 1 } : 'new'
      const { store, counts } = setup(base)
      store.set(updateSessionAtom, base.id, prev => ({ ...prev!, [key]: changed }))
      expect(counts().metadataNotifications, key).toBe(1)
      expect(store.get(sessionMetaMapAtom).get(base.id), key).toEqual(extractSessionMeta(store.get(sessionAtomFamily(base.id))!))
    }
  })

  it('does not drop new optional keys, removed keys, or new metadata object references', () => {
    const { store, counts } = setup()
    store.set(updateSessionAtom, 'stream', prev => ({ ...prev!, labels: ['one'] }))
    store.set(updateSessionAtom, 'stream', prev => ({ ...prev!, labels: [...prev!.labels!] }))
    store.set(updateSessionAtom, 'stream', prev => {
      const { labels, ...rest } = prev!
      return rest
    })
    expect(counts().metadataNotifications).toBe(3)
  })
})
