import { constants, openSync, closeSync, fstatSync, readFileSync, writeSync, fsyncSync, watch, type FSWatcher } from 'node:fs'
import { dirname, basename } from 'node:path'
import { DesktopGateway, type DesktopScope } from '@craft-agent/server-core/desktop'
import type { SessionManager } from '@craft-agent/server-core/sessions'

export interface DesktopDeployment {
  origin: string
  rpcOrigin?: string
  upstream: { host: string; port: number; passwordFile: string }
  entitlements: Array<DesktopScope & { expiresAt: string }>
}

/** Open once, refuse links, and verify the same inode we read/write. */
function privateFd(path: string, flags: number, maxSize: number): number {
  const fd = openSync(path, flags | constants.O_NOFOLLOW, 0o600)
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || (st.mode & 0o077) !== 0 || ![0, process.getuid!()].includes(st.uid) || st.size > maxSize) throw new Error('Unsafe desktop file')
    return fd
  } catch (error) { closeSync(fd); throw error }
}
function privateRead(path: string, maxSize: number): string {
  const fd = privateFd(path, constants.O_RDONLY, maxSize)
  try { return readFileSync(fd, 'utf8') } finally { closeSync(fd) }
}

/** TigerVNC VncAuth uses the first eight ASCII bytes as its DES key. */
export function effectiveVncPassword(raw: string): string {
  const value = raw.replace(/\r?\n$/, '')
  if (!value || value.length > 128 || /[^\x20-\x7e]/.test(value)) throw new Error('Unsupported desktop secret format')
  return Buffer.from(value, 'ascii').subarray(0, 8).toString('ascii')
}

export function createDesktopRuntime(path: string | undefined) {
  if (!path) return undefined
  // Parent must be an existing operator/user-owned private directory, not a link.
  const parent = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const st = fstatSync(parent)
    if ((st.mode & 0o077) !== 0 || ![0, process.getuid!()].includes(st.uid)) throw new Error('Unsafe desktop directory')
  } finally { closeSync(parent) }
  const load = () => {
    const config = JSON.parse(privateRead(path, 65536)) as DesktopDeployment
    if (!Array.isArray(config.entitlements) || config.entitlements.length > 100) throw new Error('Invalid desktop entitlements')
    return config
  }
  const initial = load()
  const journal = `${path}.revoked`
  const initialJournal = privateFd(journal, constants.O_WRONLY | constants.O_APPEND, 1024 * 1024)
  closeSync(initialJournal)
  const readRevocations = () => new Set(privateRead(journal, 1024 * 1024).split('\n').filter(Boolean).map(line => JSON.parse(line) as string))
  const revoked = readRevocations()
  const seen = new Map<string, DesktopScope>()
  const key = (s: DesktopScope) => JSON.stringify([s.workspaceId, s.sessionId])
  let manager: SessionManager | undefined
  let disabled = false
  const permitted = (scope: DesktopScope) => {
    if (disabled || revoked.has(scope.sessionId) || readRevocations().has(scope.sessionId)) return false
    const current = load()
    if (JSON.stringify({ ...current, entitlements: [] }) !== JSON.stringify({ ...initial, entitlements: [] })) return false
    return current.entitlements.some(e => e.workspaceId === scope.workspaceId && e.sessionId === scope.sessionId && Date.parse(e.expiresAt) > Date.now())
  }
  const gateway = new DesktopGateway({
    origin: initial.origin,
    rpcOrigin: initial.rpcOrigin,
    upstream: {
      host: initial.upstream.host, port: initial.upstream.port,
      password: async () => effectiveVncPassword(privateRead(initial.upstream.passwordFile, 130)),
    },
    authorize: async () => false,
    authorizeRpc: async (context, scope) => {
      if (!manager || context.workspaceId !== scope.workspaceId || !permitted(scope)) return false
      seen.set(key(scope), scope)
      const session = await manager.getSession(scope.sessionId)
      // Files and expiry may change while session messages load from disk.
      return session?.workspaceId === scope.workspaceId && permitted(scope)
    },
  })
  const revokeSession = (id: string) => {
    revoked.add(id)
    try {
      const fd = privateFd(journal, constants.O_WRONLY | constants.O_APPEND, 1024 * 1024)
      try { writeSync(fd, `${JSON.stringify(id)}\n`); fsyncSync(fd) } finally { closeSync(fd) }
    } catch {
      // Fail viewing closed, but never prevent the user's actual stop/delete.
      disabled = true
      gateway.dispose()
    }
    for (const scope of seen.values()) if (scope.sessionId === id) gateway.revoke(scope)
  }
  let watcher: FSWatcher | undefined = watch(dirname(path), (_event, name) => {
    if (!name || [basename(path), basename(journal)].includes(name.toString())) {
      for (const scope of seen.values()) gateway.revoke(scope)
    }
  })
  watcher.unref()
  return {
    gateway,
    bind(sm: SessionManager) {
      manager = sm
      const cancel = sm.cancelProcessing.bind(sm)
      const remove = sm.deleteSession.bind(sm)
      sm.cancelProcessing = async (...args) => { revokeSession(args[0]); return cancel(...args) }
      sm.deleteSession = async (...args) => { revokeSession(args[0]); return remove(...args) }
    },
    dispose() { watcher?.close(); watcher = undefined; gateway.dispose() },
  }
}
