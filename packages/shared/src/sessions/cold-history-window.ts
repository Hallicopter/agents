import { open, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { expandSessionPath } from './jsonl'
import type { StoredMessage } from './types'

// Internal disk cursor, not a public RPC token. Callers must bind it to an authorized
// session and must prefer managed state when it has unpersisted changes.
interface DiskCursor { revision: string; end: number }
const MAX_READ = 96 * 1024
const MAX_ROWS = 64
const fingerprint = (s: {dev:bigint;ino:bigint;size:bigint;mtimeNs:bigint;ctimeNs:bigint}) =>
  `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`

/** Read only the suffix of an atomic JSONL snapshot. Never silently skip a giant,
 * incomplete or malformed record, or claim that the returned window is full history. */
export async function readColdHistoryWindow(path: string, cursor?: DiskCursor) {
  const file = await open(path, 'r')
  try {
    const initial = await file.stat({bigint:true}), revision = fingerprint(initial)
    const size = Number(initial.size), end = cursor?.end ?? size
    if (!Number.isSafeInteger(size) || !Number.isSafeInteger(end) || end < 0 || end > size || (cursor && revision !== cursor.revision)) throw Error('History changed; reopen the window')
    const start = Math.max(0, end - MAX_READ), buf = Buffer.alloc(end-start)
    let read = 0
    while (read < buf.length) {
      const {bytesRead} = await file.read(buf,read,buf.length-read,start+read)
      if (!bytesRead) throw Error('History read was incomplete')
      read += bytesRead
    }
    const messages:StoredMessage[] = []
    let pos=buf.length, more=false, blocked=false
    if (pos && buf[pos-1]===10) pos--
    let nextEnd=end
    while(pos>0) {
      const lf=buf.lastIndexOf(10,pos-1)
      if(lf<0) {
        // At offset zero this line is the header. Otherwise it may be a partial line.
        more=start>0; blocked=more && !messages.length; break
      }
      const line=buf.subarray(lf+1,pos); pos=lf
      if(!line.length) continue
      if(messages.length===MAX_ROWS){ more=true; break }
      const message:StoredMessage=JSON.parse(expandSessionPath(line.toString('utf8'),dirname(path)))
      if(!message || typeof message.id!=='string' || typeof message.type!=='string') throw Error('Invalid stored history record')
      messages.push(message); nextEnd=start+lf+1
    }
    if (pos === 0 && start > 0) { more = true; blocked = !messages.length }
    // Writers atomically replace the path; fstat on the old handle alone misses that.
    if(fingerprint(await stat(path,{bigint:true}))!==revision) throw Error('History changed; reopen the window')
    return {messages:messages.reverse(),bytesRead:read,revision,blocked,
      older: more && !blocked ? {revision,end:nextEnd} : null}
  } finally { await file.close() }
}
