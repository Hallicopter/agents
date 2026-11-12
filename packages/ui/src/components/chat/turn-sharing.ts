import type { Turn } from './turn-utils'

/** Compare derived turn data, not just IDs. Immutable input subtrees normally
 * short-circuit by identity. Conservatively reject non-plain values so future
 * Date/Map/class fields cannot be mistaken for equal empty objects. */
function sameDerivedValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length
      && a.every((value, index) => sameDerivedValue(value, b[index]))
  }
  const prototype = Object.getPrototypeOf(a)
  if (prototype !== Object.getPrototypeOf(b) || (prototype !== Object.prototype && prototype !== null)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(key =>
    Object.prototype.hasOwnProperty.call(b, key)
    && sameDerivedValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
  )
}

/** Reuse unchanged COMPLETE assistant turns so streaming a later answer does
 * not invalidate historical TurnCard/Markdown trees. No global cache, retained
 * histories or ID-only shortcuts. Every derived field (including annotations,
 * tool results, todos and future additions) participates in equality. Active
 * turns are always fresh. Reorders/retractions may miss reuse, never updates. */
export function reuseUnchangedTurns(previous: readonly Turn[], next: Turn[]): Turn[] {
  return next.map((turn, index) => {
    const old = previous[index]
    return turn.type === 'assistant' && turn.isComplete && !turn.isStreaming
      && old?.type === 'assistant' && old.isComplete && !old.isStreaming
      && sameDerivedValue(old, turn) ? old : turn
  })
}
