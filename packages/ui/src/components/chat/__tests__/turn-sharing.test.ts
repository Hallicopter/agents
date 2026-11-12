import { describe, expect, it } from 'bun:test'
import type { Message } from '@craft-agent/core'
import { groupMessagesByTurn, reuseUnchangedTurns, type AssistantTurn } from '../turn-utils'

const base: Message[] = [
  { id: 'u1', role: 'user', content: 'Question', timestamp: 1 },
  { id: 'tool', role: 'tool', content: '', timestamp: 2, toolUseId: 'tool-1', toolName: 'Read', toolResult: 'before', toolStatus: 'completed' },
  { id: 'a1', role: 'assistant', content: 'Completed response', timestamp: 3 },
  { id: 'u2', role: 'user', content: 'Next', timestamp: 4 },
  { id: 'a2', role: 'assistant', content: 'stream', timestamp: 5, isStreaming: true },
]
const group = (messages = base, processing = true) => groupMessagesByTurn(messages, { isSessionProcessing: processing })

describe('completed turn structural sharing', () => {
  it('reuses complete history, never the active turn, and keeps derived output identical', () => {
    const before = group()
    const next = group(base.map(m => m.id === 'a2' ? { ...m, content: 'stream plus delta' } : m))
    const result = reuseUnchangedTurns(before, next)
    expect(result).toEqual(next)
    expect(result[1]).toBe(before[1])
    expect((result[1] as AssistantTurn).activities).toBe((before[1] as AssistantTurn).activities)
    expect(result[3]).toBe(next[3])
    expect(result[3]).not.toBe(before[3])
  })

  it('does not freeze completed response edits, tool output, or authoritative IDs', () => {
    const before = group()
    for (const messages of [
      base.map(m => m.id === 'a1' ? { ...m, content: 'Corrected response' } : m),
      base.map(m => m.id === 'tool' ? { ...m, toolResult: 'after', toolStatus: 'error' as const, isError: true } : m),
      base.map(m => m.id === 'a1' ? { ...m, id: 'canonical' } : m),
      base.map(m => m.id === 'tool' ? { ...m, toolInput: { password: '[redacted]' } } : m),
    ]) {
      const next = group(messages)
      const shared = reuseUnchangedTurns(before, next)
      expect(shared).toEqual(next)
      expect(shared[1]).not.toBe(before[1])
    }
  })

  it('compares every derived field, including future fields and nested annotations', () => {
    const complete = group()[1] as AssistantTurn
    const values: Record<string, unknown> = {
      turnId: 'changed', timestamp: 900, intent: 'new intent',
      response: { ...complete.response, annotations: [{ id: 'note', body: 'new note', nested: { resolved: true } }] },
      todos: [{ content: 'todo', status: 'completed' }],
      activities: [...complete.activities, { id: 'new', type: 'plan', content: 'plan' }],
      futureField: 'new field',
    }
    for (const [key, value] of Object.entries(values)) {
      const next = { ...complete, [key]: value }
      expect(reuseUnchangedTurns([complete], [next])[0], key).toBe(next)
    }
    const withAnnotations = { ...complete, response: { ...complete.response!, annotations: [{ id: 'a', note: 'before' }] } } as unknown as AssistantTurn
    const edited = { ...withAnnotations, response: { ...withAnnotations.response!, annotations: [{ id: 'a', note: 'after' }] } } as unknown as AssistantTurn
    expect(reuseUnchangedTurns([withAnnotations], [edited])[0]).toBe(edited)
  })

  it('preserves retractions, interruption/terminal fallback, plans and reordered histories', () => {
    const before = group()
    for (const messages of [base.filter(m => m.id !== 'a1'), [...base].reverse(),
      [...base, { id: 'error', role: 'error' as const, content: 'error', timestamp: 6 }],
      [...base, { id: 'info', role: 'info' as const, content: 'Interrupted', timestamp: 6 }],
      [...base, { id: 'plan', role: 'plan' as const, content: 'Plan', timestamp: 6 }],
    ]) {
      const next = group(messages, false)
      expect(reuseUnchangedTurns(before, next)).toEqual(next)
    }
  })

  it('does not treat future non-plain fields as equal or reuse removed keys', () => {
    const complete = group()[1] as AssistantTurn
    const old = { ...complete, future: new Map([['before', 1]]) }
    const next = { ...complete, future: new Map([['after', 2]]) }
    expect(reuseUnchangedTurns([old], [next])[0]).toBe(next)
    expect(reuseUnchangedTurns([old], [complete])[0]).toBe(complete)
  })
})
