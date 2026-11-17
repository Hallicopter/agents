import { RPC_CHANNELS, type HistoryCursor, type SessionHistoryWindow } from '@craft-agent/shared/protocol'
import type { RpcServer } from '../../transport/types'
import { serializeEnvelope } from '../../transport/codec'
import type { HandlerDeps } from '../handler-deps'

// Hydration stays authoritative (including disk-only settings). Only the UI
// projection is sliced: never replace the model's managed transcript.
export function registerHistoryWindow(server: RpcServer, deps: HandlerDeps) {
  const channel = RPC_CHANNELS.sessions.HISTORY_WINDOW
  server.handle(channel, async (ctx, id: string, cursor?: HistoryCursor): Promise<SessionHistoryWindow> => {
    const scope = () => ctx.workspaceId ?? (ctx.webContentsId != null ? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId) : null)
    const workspace = scope(), manager = deps.sessionManager
    if (!workspace || manager.getSessionSnapshot(id)?.workspaceId !== workspace) throw Error('History unavailable')
    const session = await manager.getSession(id)
    if (!session || session.workspaceId !== workspace || workspace !== scope() || manager.getSessionSnapshot(id)?.workspaceId !== workspace) throw Error('History changed')
    const revision = manager.getHistoryRevision(id)
    if (!revision || (cursor && revision !== cursor.revision)) throw Error('History changed; refresh recent messages')
    const { messages, ...metadata } = session
    // Preview is a list excerpt, not transcript content or a composer option.
    metadata.preview = metadata.preview?.slice(0, 240)
    const end = cursor ? messages.findIndex(m => m.id === cursor.before) : messages.length
    if (end < 0) throw Error('History anchor unavailable')
    let start = Math.max(0, end - 64)
    while (true) {
      const page = { metadata, messages: messages.slice(start, end), older: start ? {revision, before: messages[start].id} : null }
      if (Buffer.byteLength(serializeEnvelope({type:'response', channel, id:'x'.repeat(128), result:page})) <= 127 * 1024) return page
      if (end - start <= 1) throw Error('History detail exceeds the page budget; full history is required')
      start += Math.ceil((end - start) / 2)
    }
  })
}
