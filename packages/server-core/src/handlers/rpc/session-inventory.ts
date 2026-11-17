import type { Session, SessionInventoryPage } from '@craft-agent/shared/protocol'

// Reserve room for the transport envelope and cursor. Ordinary rows travel natively;
// a single exceptional metadata row can span pages without truncation or a giant frame.
export const INVENTORY_BYTES = 192 * 1024
const MAX_ROWS = 100
export function* inventoryPages(ids: readonly string[], snapshot: (id: string) => Session | null): Generator<Omit<SessionInventoryPage, 'next'>, Omit<SessionInventoryPage, 'next'>> {
  let sessions: Session[] = [], bytes = 0
  for (const id of ids) {
    const row = snapshot(id)
    if (!row) continue // deleted or moved since the list of IDs was frozen
    const json = JSON.stringify(row)
    const size = Buffer.byteLength(json) + 1
    if (sessions.length && (bytes + size > INVENTORY_BYTES || sessions.length >= MAX_ROWS)) {
      yield { sessions }; sessions = []; bytes = 0
    }
    if (size > INVENTORY_BYTES) {
      // A UTF-16 unit costs at most six bytes when JSON-escaped for the outer frame.
      const stride = Math.floor(INVENTORY_BYTES / 6)
      for (let i = 0; i < json.length; i += stride) {
        yield { sessions: [], fragment: json.slice(i, i + stride), endRow: i + stride >= json.length }
      }
    } else {
      sessions.push(row); bytes += size
    }
  }
  return { sessions }
}
