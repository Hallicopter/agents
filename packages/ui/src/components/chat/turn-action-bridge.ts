import type { TurnCardProps } from './TurnCard'

export const TURN_ACTION_KEYS = [
  'onExpandedChange', 'onExpandedActivityGroupsChange', 'onOpenFile', 'onOpenUrl',
  'onPopOut', 'onOpenDetails', 'onOpenActivityDetails', 'onOpenMultiFileDiff',
  'onAcceptPlan', 'onAcceptPlanWithCompact', 'onBranch', 'onAddAnnotation',
  'onRemoveAnnotation', 'onUpdateAnnotation', 'onSaveAndSendFollowUp',
] as const
export type TurnActionKey = typeof TURN_ACTION_KEYS[number]

/** Stable event handlers read only the owner's latest COMMITTED props. This
 * is not a render-prop cache: publish from a layout effect, not during render,
 * so an aborted concurrent render cannot replace action context/authority. */
export function createTurnActionBridge(readCommitted: () => TurnCardProps | null): Pick<TurnCardProps, TurnActionKey> {
  return Object.fromEntries(TURN_ACTION_KEYS.map(key => [key, (...args: unknown[]) => {
    const action = readCommitted()?.[key]
    return (action as ((...args: unknown[]) => unknown) | undefined)?.(...args)
  }])) as Pick<TurnCardProps, TurnActionKey>
}
