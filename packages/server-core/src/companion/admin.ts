import { createServer, createConnection } from 'node:net'
import { chmodSync, lstatSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { CompanionStore } from './store'

/** Filesystem-protected local administrative channel. Never attached to the HTTP router. */
export async function startCompanionAdmin(store: CompanionStore, validWorkspace: (id: string) => boolean) {
  const path = join(store.directory, 'admin.sock')
  // Never unlink an existing path: could be another running instance or a symlink.
  try { lstatSync(path); throw new Error('Companion admin socket exists; verify no instance is running and remove stale socket manually') }
  catch (e: any) { if (e.code !== 'ENOENT') throw e }
  const server = createServer(socket => {
    socket.setTimeout(3000, () => socket.destroy())
    let input = ''
    socket.on('data', chunk => {
      input += chunk.toString()
      if (input.length > 8192) { socket.destroy(); return }
      if (!input.includes('\n')) return
      socket.pause()
      try {
        const b = JSON.parse(input.split('\n')[0]!)
        let data: unknown
        if (b.action === 'mint') {
          if (typeof b.workspaceId !== 'string' || !validWorkspace(b.workspaceId)) throw new Error('Unknown workspace')
          if (b.sessionIds !== undefined && (!Array.isArray(b.sessionIds) || b.sessionIds.length > 200 || b.sessionIds.some((s: unknown) => typeof s !== 'string' || !/^[A-Za-z0-9_-]{1,150}$/.test(s)))) throw new Error('Invalid session IDs')
          data = store.mint(b.workspaceId, { chat: b.allowChat === true, create: b.allowCreate === true, existingPermissions: b.allowExistingPermissions === true, allSessions: b.allSessions === true, sessionIds: b.sessionIds })
        } else if (b.action === 'list') data = store.list()
        else if (b.action === 'revoke' && typeof b.deviceId === 'string') data = { revoked: store.revoke(b.deviceId) }
        else throw new Error('Unknown operation')
        socket.end(JSON.stringify({ ok: true, data }) + '\n')
      } catch { socket.end(JSON.stringify({ ok: false, error: 'Invalid admin request' }) + '\n') }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => { chmodSync(path, 0o600); resolve() })
  })
  const owned = lstatSync(path)
  server.once('close', () => {
    try {
      const current = lstatSync(path)
      if (current.isSocket() && current.dev === owned.dev && current.ino === owned.ino) unlinkSync(path)
    } catch { /* Leave uncertain paths for explicit operator reconciliation. */ }
  })
  return server
}
export function companionAdminRequest(path: string, request: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path)
    let result = ''
    socket.setTimeout(5000, () => socket.destroy(new Error('Admin request timed out')))
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'))
    socket.on('data', data => { result += data.toString(); if (result.length > 100_000) socket.destroy(new Error('Response too large')) })
    socket.on('end', () => resolve(result))
    socket.on('error', reject)
  })
}
