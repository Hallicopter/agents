import { randomUUID } from 'node:crypto'
import { storedToMessage } from '@craft-agent/core'
import { RPC_CHANNELS, type ColdHistoryPage } from '@craft-agent/shared/protocol'
import type { DiskCursor } from '@craft-agent/shared/sessions'
import type { RpcServer } from '../../transport/types'
import { serializeEnvelope } from '../../transport/codec'
import type { HandlerDeps } from '../handler-deps'

// One expiry-bound continuation per connection. Only the opaque token crosses the wire.
export function registerColdHistoryHandler(server: RpcServer, deps: HandlerDeps) {
  const cursors = new Map<string, { sessionId: string; scope: string; token: string; cursor?: DiskCursor; expires: ReturnType<typeof setTimeout> }>()
  const channel = RPC_CHANNELS.sessions.COLD_HISTORY_PAGE
  server.handle(channel, async (ctx, sessionId: string, next?: string): Promise<ColdHistoryPage> => {
    const scope = ctx.workspaceId ?? (ctx.webContentsId != null ? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId) : undefined)
    if (!scope || typeof sessionId !== 'string' || deps.sessionManager.getSessionSnapshot(sessionId)?.workspaceId !== scope) throw Error('History unavailable')
    const old = cursors.get(ctx.clientId)
    if (next !== undefined && (!old?.cursor || next !== old.token || old.scope !== scope || old.sessionId !== sessionId)) throw Error('History cursor expired')
    if (old) clearTimeout(old.expires)
    const expires = setTimeout(() => cursors.delete(ctx.clientId), 60_000); expires.unref()
    const state = {token:randomUUID(), scope, sessionId, expires, cursor:undefined as DiskCursor | undefined}
    cursors.set(ctx.clientId,state)
    try {
      const page = await deps.sessionManager.readColdHistoryPage(sessionId,scope,next ? old?.cursor : undefined)
      if (cursors.get(ctx.clientId)!==state || deps.sessionManager.getSessionSnapshot(sessionId)?.workspaceId!==scope) throw Error('History changed')
      if (!page) return {kind:'unavailable',reason:'state-changed'}
      if (page.blocked) return {kind:'unavailable',reason:'oversized'}
      const result:ColdHistoryPage = {kind:'page',messages:page.messages.map(storedToMessage),next:page.older ? state.token : null}
      // Include the actual wire codec (not JS character counts), reserving envelope overhead.
      if (Buffer.byteLength(serializeEnvelope({id:'x'.repeat(128),type:'response',channel,result})) > 128*1024-1024) return {kind:'unavailable',reason:'oversized'}
      state.cursor=page.older ?? undefined
      return result
    } finally {
      if (!state.cursor && cursors.get(ctx.clientId)===state) {clearTimeout(expires);cursors.delete(ctx.clientId)}
    }
  })
}
