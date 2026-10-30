import { constants, openSync, closeSync, fstatSync, readFileSync, writeSync, fsyncSync, watch, type FSWatcher } from 'node:fs'
import { dirname, basename, join } from 'node:path'
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

/** Systemd exposes root-owned read-only credentials via a named-user ACL.
 * The apparent group mode bits are the ACL mask, not a group permission grant.
 * Only the exact systemd-injected credential namespace is eligible; never config/journal.
 */
export function readSystemdDesktopCredential(path: string): string {
  const directory = process.env.CREDENTIALS_DIRECTORY
  if (!directory || !/^\/run\/credentials\/[^/.][^/]*$/.test(directory) || path !== join(directory, 'desktop-vnc')) throw new Error('Desktop credential namespace required')
  const run = openSync('/run', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  let credentials: number | undefined
  let dir: number | undefined
  try {
    const rs = fstatSync(run)
    if (rs.uid !== 0 || (rs.mode & 0o022) !== 0) throw new Error('Unsafe credential ancestor')
    credentials = openSync(`/proc/self/fd/${run}/credentials`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    const cs = fstatSync(credentials)
    if (cs.uid !== 0 || (cs.mode & 0o022) !== 0) throw new Error('Unsafe credential ancestor')
    dir = openSync(`/proc/self/fd/${credentials}/${basename(directory)}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    const ds = fstatSync(dir)
    if (ds.uid !== 0 || ds.gid !== 0 || ![0o500, 0o550].includes(ds.mode & 0o777)) throw new Error('Unsafe systemd credential directory')
    // Pin the directory inode while opening its final component (no ancestor race).
    const fd = openSync(`/proc/self/fd/${dir}/desktop-vnc`, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const st = fstatSync(fd)
      if (!st.isFile() || st.uid !== 0 || st.gid !== 0 || ![0o400, 0o440].includes(st.mode & 0o777) || st.size > 130) throw new Error('Unsafe systemd desktop credential')
      return readFileSync(fd, 'utf8')
    } finally { closeSync(fd) }
  } finally { if (dir !== undefined) closeSync(dir); if (credentials !== undefined) closeSync(credentials); closeSync(run) }
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
      password: async () => effectiveVncPassword(readSystemdDesktopCredential(initial.upstream.passwordFile)),
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
