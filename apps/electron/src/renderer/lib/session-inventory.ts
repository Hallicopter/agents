import type { Session, SessionInventoryPage, SessionInventoryRequest } from '@craft-agent/shared/protocol'

/** Pull exactly one network page per caller request. No prefetch on the selected chat's link. */
export function openInventory(priorityIds: string[], get: (request: SessionInventoryRequest) => Promise<SessionInventoryPage | Session[]>) {
  let next: string | null | undefined
  let fragments: string[] = []
  return async () => {
    if (next === null) throw new Error('Session inventory already complete')
    const result = await get(next ? { page: true, next } : { page: true, priorityIds })
    // An older server ignores the options and returns the complete legacy list.
    if (Array.isArray(result)) { next = null; return { sessions: result, more: false } }
    next = result.next
    if (result.discardFragments) fragments = []
    if (result.fragment !== undefined) fragments.push(result.fragment)
    let sessions = result.sessions
    if (result.endRow) {
      sessions = [...sessions, JSON.parse(fragments.join('')) as Session]; fragments = []
    }
    return { sessions, more: next !== null }
  }
}
