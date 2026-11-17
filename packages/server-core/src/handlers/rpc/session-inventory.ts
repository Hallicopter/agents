import type { Session, SessionInventoryPage } from '@craft-agent/shared/protocol'

export const INVENTORY_BYTES = 192 * 1024
const MAX_ROWS = 100

/** A navigable stub for exceptional rows; never mark their inventory complete until the full row arrives. */
export function navigationSummary(s: Session): Session {
  return { id: s.id, workspaceId: s.workspaceId, workspaceName: s.workspaceName.slice(0, 128),
    name: s.name?.slice(0, 256), preview: s.preview?.slice(0, 256), lastMessageAt: s.lastMessageAt,
    messages: [], isProcessing: s.isProcessing, hidden: s.hidden, isArchived: s.isArchived,
    lastFinalMessageId: s.lastFinalMessageId, isFlagged: s.isFlagged, sessionStatus: s.sessionStatus, projectId: s.projectId,
    parentSessionId: s.parentSessionId, permissionMode: s.permissionMode, previousPermissionMode: s.previousPermissionMode,
    codingMode: s.codingMode, thinkingLevel: s.thinkingLevel, messageCount: s.messageCount }
}

type Page = Omit<SessionInventoryPage, 'next'>
export function* inventoryPages(ids: readonly string[], snapshot: (id: string) => Session | null): Generator<Page, Page> {
  let sessions: Session[] = [], bytes = 0
  for (let index = 0; index < ids.length;) {
    if (sessions.length === MAX_ROWS) { yield { sessions }; sessions = []; bytes = 0 }
    const id = ids[index]
    const row = snapshot(id)
    if (!row) { index++; continue }
    const json = JSON.stringify(row), size = Buffer.byteLength(json) + 1
    if (sessions.length && bytes + size > INVENTORY_BYTES) {
      yield { sessions }; sessions = []; bytes = 0
      continue // re-read this ID after the user asks for another page
    }
    if (size > INVENTORY_BYTES) {
      yield { sessions: [navigationSummary(row)] }
      // Encode the complete row losslessly. Only commit fragments if its scope and value
      // still match at the end; otherwise discard the partial row and revisit the ID.
      const stride = Math.floor(INVENTORY_BYTES / 6)
      for (let i = 0; i < json.length; i += stride) {
        if (!snapshot(id)) break
        yield { sessions: [], fragment: json.slice(i, i + stride) }
      }
      const latest = snapshot(id)
      if (!latest || JSON.stringify(latest) !== json) {
        yield { sessions: [], discardFragments: true }
        continue
      }
      yield { sessions: [], endRow: true }
    } else {
      sessions.push(row); bytes += size
    }
    index++
  }
  return { sessions }
}
