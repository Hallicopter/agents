import { describe, expect, it } from 'bun:test'
import type { TurnCardProps } from '../TurnCard'
import { createTurnActionBridge, TURN_ACTION_KEYS } from '../turn-action-bridge'

const props: TurnCardProps = { sessionId: 'one', turnId: 't', activities: [], isComplete: true, isStreaming: false }

describe('completed card action freshness', () => {
  it('keeps identities stable but invokes current branch settings and send guards', () => {
    const calls: unknown[] = []
    const old = { model: 'old', llmConnection: 'old', permissionMode: 'ask', enabledSourceSlugs: ['old'], workingDirectory: '/old', name: 'old' }
    const current = { model: 'new', llmConnection: 'new', permissionMode: 'allow-all', enabledSourceSlugs: ['new'], workingDirectory: '/new', name: 'new' }
    let committed: TurnCardProps | null = { ...props, onBranch: id => calls.push({ id, ...old }), onSaveAndSendFollowUp: () => calls.push('sent') }
    const bridge = createTurnActionBridge(() => committed)
    const retainedBranch = bridge.onBranch!
    const retainedSend = bridge.onSaveAndSendFollowUp!
    retainedBranch('historical')
    // A pending/aborted render is NOT published by the owner.
    const candidate = { ...props, onBranch: (id: string) => calls.push({ id, ...current }), onSaveAndSendFollowUp: () => calls.push('blocked') }
    retainedBranch('before-commit')
    committed = candidate
    retainedBranch('after-commit')
    retainedSend({ messageId: 'm', annotationId: 'a', note: 'n', selectedText: 's' })
    expect(calls).toEqual([{ id: 'historical', ...old }, { id: 'before-commit', ...old }, { id: 'after-commit', ...current }, 'blocked'])
    expect(bridge.onBranch).toBe(retainedBranch)
  })
  it('forwards every event argument to current context, including expansion keys and annotations', () => {
    const calls: unknown[] = []
    let committed: TurnCardProps | null = props
    const bridge = createTurnActionBridge(() => committed)
    for (const key of TURN_ACTION_KEYS) {
      committed = { ...props, [key]: (...args: unknown[]) => calls.push({ key, args, session: 'current' }) }
      ;(bridge[key] as (...args: unknown[]) => unknown)('message', { fresh: true })
      expect(calls.at(-1)).toEqual({ key, args: ['message', { fresh: true }], session: 'current' })
    }
  })
  it('removal, unmount and session switch cannot keep old actions alive', () => {
    const calls: string[] = []
    let committed: TurnCardProps | null = { ...props, onBranch: () => calls.push('one') }
    const bridge = createTurnActionBridge(() => committed)
    const retained = bridge.onBranch!
    committed = { ...props, onBranch: undefined }
    retained('removed')
    committed = { ...props, sessionId: 'two', onBranch: () => calls.push('two') }
    retained('current-session')
    committed = null
    retained('unmounted')
    expect(calls).toEqual(['two'])
  })
})
