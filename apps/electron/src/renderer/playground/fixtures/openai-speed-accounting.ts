/** Offline golden renderer payload, NOT a provider response or proof of Ultrafast success.
 * The adapter's independently tested fix supplies this canonical error+complete shape.
 */
import type { Session } from '../../../shared/types'
import type { AgentEvent } from '../../event-processor/types'

export const SYNTHETIC_SPEED_MISMATCH = 'Synthetic fixture: requested OpenAI Ultrafast, but provider returned default. No assistant answer was accepted.'
export const STANDARD_MISMATCH_USAGE: NonNullable<Session['tokenUsage']> = {
  inputTokens: 6714,
  outputTokens: 14,
  totalTokens: 6728,
  contextTokens: 6714,
  // Native occupancy is a separate quantity, not the consumed/billable input count.
  // This synthetic snapshot invents neither a context limit nor compaction eligibility.
  contextUsage: {
    usedTokens: 11000,
    limitKind: 'context',
    isEstimate: true,
    isStale: false,
    canCompact: false,
  },
  // Standard-rate estimate: 6714 * $2/M input + 14 * $10/M output. No premium multiplier.
  costUsd: 0.013568,
}

export function makeSpeedMismatchEvents(sessionId: string): AgentEvent[] {
  return [
    { type: 'error', sessionId, error: SYNTHETIC_SPEED_MISMATCH, timestamp: 1794945600000 },
    { type: 'complete', sessionId, tokenUsage: { ...STANDARD_MISMATCH_USAGE } },
  ]
}
