/**
 * Session Options Types
 *
 * Type definitions and helpers for session-scoped settings.
 * The actual hook is in AppShellContext.tsx as useSessionOptionsFor().
 *
 * ADDING A NEW SESSION OPTION:
 * 1. Add field to SessionOptions interface below
 * 2. Update defaultSessionOptions
 * 3. Add UI control in FreeFormInput.tsx (or wherever needed)
 */

import type { PermissionMode, Session } from '../../shared/types'
import type { ThinkingLevel } from '@craft-agent/shared/agent/thinking-levels'
import { DEFAULT_THINKING_LEVEL } from '@craft-agent/shared/agent/thinking-levels'

/**
 * All session-scoped options in one place.
 */
export interface SessionOptions {
  /** Permission mode ('safe', 'ask', 'guarded', 'allow-all') */
  permissionMode: PermissionMode
  /** Monotonic version from backend permission mode state (used to ignore stale events) */
  permissionModeVersion?: number
  /** Mode before the last change (an approved plan leaving Explore returns to Guarded from it) */
  previousPermissionMode?: PermissionMode
  /** Session-level thinking level — sticky, persisted. See {@link ThinkingLevel}. */
  thinkingLevel: ThinkingLevel
  /** Coding mode — lean coding prompt and session tools; fixed once the conversation starts */
  codingMode: boolean
}

/** Default values for new sessions */
export const defaultSessionOptions: SessionOptions = {
  permissionMode: 'ask', // Default to ask mode (prompt for permissions)
  thinkingLevel: DEFAULT_THINKING_LEVEL, // Default to 'medium' level
  codingMode: false,
}

/** Type for partial updates to session options */
export type SessionOptionUpdates = Partial<SessionOptions>

/** Helper to merge session options with updates */
export function mergeSessionOptions(
  current: SessionOptions | undefined,
  updates: SessionOptionUpdates
): SessionOptions {
  return {
    ...defaultSessionOptions,
    ...current,
    ...updates,
  }
}


/** Fold list/getMessages metadata into UI options with one Map copy, not one per session. */
export function mergeSessionOptionsFromSnapshots(
  previous: Map<string, SessionOptions>,
  sessions: Iterable<Pick<Session, 'id' | 'permissionMode' | 'previousPermissionMode' | 'thinkingLevel' | 'codingMode'>>,
): Map<string, SessionOptions> {
  const next = new Map(previous)
  for (const session of sessions) {
    const current = next.get(session.id)
    const merged = mergeSessionOptions(current, {
      permissionMode: current?.permissionModeVersion != null ? current.permissionMode : session.permissionMode ?? defaultSessionOptions.permissionMode,
      previousPermissionMode: current?.permissionModeVersion != null ? current.previousPermissionMode : session.previousPermissionMode,
      thinkingLevel: session.thinkingLevel ?? defaultSessionOptions.thinkingLevel,
      codingMode: session.codingMode === true,
    })
    if (merged.permissionMode === defaultSessionOptions.permissionMode
      && merged.thinkingLevel === defaultSessionOptions.thinkingLevel
      && !merged.codingMode && merged.previousPermissionMode == null && merged.permissionModeVersion == null) {
      next.delete(session.id)
    } else {
      next.set(session.id, merged)
    }
  }
  return next
}
