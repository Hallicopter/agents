import { createHash, randomUUID } from 'node:crypto'
import { RPC_CHANNELS, type HistoryCursor, type SessionHistoryWindow, type HistoryChunk } from '@craft-agent/shared/protocol'
import type { RpcServer } from '../../transport/types'
import { serializeEnvelope } from '../../transport/codec'
import type { HandlerDeps } from '../handler-deps'

// Wire projection only. Cold managers still hydrate their full authoritative transcript.
export function registerHistoryWindow(server: RpcServer, deps: HandlerDeps) {
  const channel = RPC_CHANNELS.sessions.HISTORY_WINDOW
  const chunks = new Map<string,{body:string; owner:string; expires:ReturnType<typeof setTimeout>}>()
  function piece(token:string, owner:string, offset:number): HistoryChunk {
    const entry = chunks.get(token)
    if (!entry || entry.owner !== owner || !Number.isSafeInteger(offset) || offset < 0 || offset >= entry.body.length) throw Error('History detail expired')
    const data = entry.body.slice(offset, offset + 16000)
    clearTimeout(entry.expires)
    const next = offset + data.length < entry.body.length ? offset + data.length : null
    if (next === null) chunks.delete(token)
    else entry.expires = setTimeout(() => chunks.delete(token), 60000)
    return {token,offset,next,data}
  }
  server.handle(channel, async (ctx, id: string, cursor?: HistoryCursor, detail?:{token:string; offset:number}): Promise<SessionHistoryWindow | HistoryChunk> => {
    const scope = () => ctx.workspaceId ?? (ctx.webContentsId != null ? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId) : null)
    const workspace = scope(), manager = deps.sessionManager
    if (!workspace || manager.getSessionSnapshot(id)?.workspaceId !== workspace) throw Error('History unavailable')
    const owner = JSON.stringify([ctx.clientId,workspace,id])
    if (detail) return piece(detail.token,owner,detail.offset)
    const loaded = await manager.getSession(id)
    const captured = manager.captureHistory?.(id)
    const session = manager.captureHistory ? captured?.session : loaded
    if (!session || session.workspaceId !== workspace || workspace !== scope() || manager.getSessionSnapshot(id)?.workspaceId !== workspace) throw Error('History changed')
    const epoch = manager.getHistoryRevision(id)
    if (!epoch) throw Error('History unavailable')
    const { messages, ...metadata } = session
    const published = !cursor && manager.getPublishedStream(id)
    const length = cursor?.length ?? messages.length
    if (!Number.isSafeInteger(length) || length < 0 || length > messages.length) throw Error('History changed; refresh recent messages')
    // Authenticate the original transcript, not an append-sensitive persistence generation.
    const hash = createHash('sha256').update(epoch)
    for (let i=0;i<length;i++) hash.update(JSON.stringify(messages[i])).update('\n')
    const revision = hash.digest('hex')
    if (cursor && revision !== cursor.revision) throw Error('History changed; refresh recent messages')
    const end = cursor ? messages.findIndex(m => m.id === cursor.before) : length
    if (end < 0 || end > length) throw Error('History anchor unavailable')
    let start = Math.max(0, end - 64)
    while (true) {
      const visible = messages.slice(start,end)
      if (published) visible.push(published)
      const page = { metadata, messages:visible, pendingPermissions:cursor ? undefined : captured?.pendingPermissions, watermark:captured?.watermark, epoch, older:start ? {revision,length,before:messages[start].id} : null }
      if (Buffer.byteLength(serializeEnvelope({type:'response',channel,id:'x'.repeat(128),result:page})) <= 127*1024) return page
      if (end-start <= 1) {
        const token = randomUUID(), body = JSON.stringify(page)
        chunks.set(token,{body,owner,expires:setTimeout(() => chunks.delete(token),60000)})
        return piece(token,owner,0)
      }
      start += Math.ceil((end-start)/2)
    }
  })
}
