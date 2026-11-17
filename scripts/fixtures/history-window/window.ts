/** Protocol spike. Caller MUST supply an immutable, chronologically ordered revision and
 * independently authenticate each request. Not registered on a production RPC channel. */
import type { Message } from '@craft-agent/core/types'
export type Entry = { kind: 'message'; message: Message } | { kind: 'deferred'; id: string; role: Message['role']; timestamp: number }
export type Cursor = { scope: string; revision: string; beforeId: string }
export type Page = { scope: string; revision: string; entries: Entry[]; older: Cursor | null }
export type Snapshot = { scope: string; revision: string; messages: readonly Message[] }
export const LIMIT = 128 * 1024
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8')
function check(s: Snapshot, c: Pick<Cursor,'scope'|'revision'>) {
  if (s.scope !== c.scope || s.revision !== c.revision) throw Error('history invalidated')
}
export function page(s: Snapshot, cursor?: Cursor, aroundId?: string): Page {
  if (cursor) check(s, cursor)
  const anchor = cursor?.beforeId ?? aroundId
  let end = anchor === undefined ? s.messages.length : s.messages.findIndex(m=>m.id===anchor)
  if (end < 0) throw Error('history anchor unavailable')
  if (!cursor && aroundId !== undefined) end++
  const entries: Entry[] = []; let size = 0
  while (end > 0 && entries.length < 64) {
    const m = s.messages[end-1]!
    let row: Entry = {kind:'message', message:m}
    let n = bytes(row) + 1
    if (n > LIMIT - 4096) {
      row = {kind:'deferred', id:m.id, role:m.role, timestamp:m.timestamp}; n = bytes(row)+1
    }
    if (n > LIMIT - 4096) throw Error('history identifier too large')
    if (size+n > LIMIT-4096) break
    entries.push(row); size+=n; end--
  }
  const older = end > 0 ? { scope:s.scope,revision:s.revision,beforeId:s.messages[end]!.id } : null
  const result = { scope:s.scope, revision:s.revision, entries:entries.reverse(), older }
  if (bytes(result) > LIMIT - 1024) throw Error('history envelope too large')
  return result
}
// Explicit retrieval; never substitute truncated content in a Message. JS string slices
// rejoin even across surrogate pairs; caller parses only after checking final revision.
export function detail(s: Snapshot, ref: Pick<Cursor,'scope'|'revision'>, id:string, offset:number) {
  check(s, ref)
  const message=s.messages.find(m=>m.id===id)
  if (!message) throw Error('history anchor unavailable')
  const raw=JSON.stringify(message)
  if (!Number.isSafeInteger(offset)||offset<0||offset>=raw.length) throw Error('invalid offset')
  const text=raw.slice(offset,offset+16*1024)
  return {text, next:offset+text.length===raw.length?null:offset+text.length}
}
