import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { InputArbiter, type HumanInputScope, type InputArbiterJournal } from '../../server-core/src/desktop/input-arbiter'
import { createUnixInputBroker, type UnixInputBroker } from '../../server-core/src/desktop/input-broker'
import type { DesktopControlOptions, DesktopScope } from '../../server-core/src/desktop/gateway'

export interface DesktopControlDeployment {
  socketPath: string
  journalPath: string
  ownerFile: string
  proxyPath: string
  drainHelper: string
}

/** Host-only opt-in. Same UID and root are trusted; this does not fence direct VNC clients.
 * Never reset a dirty journal or silently allow unregistered legacy proxies. */
export function createDesktopControlRuntime(config: DesktopControlDeployment, authorized: (scope: DesktopScope) => boolean, expiresAt: (scope: DesktopScope) => number) {
  const privateFile = (path: string) => {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const st = fstatSync(fd)
      if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o077) || st.size > 65536) throw new Error('Private control file required')
      return readFileSync(fd, 'utf8')
    } finally { closeSync(fd) }
  }
  const initial = JSON.parse(privateFile(config.journalPath)) as InputArbiterJournal
  const parent = lstatSync(dirname(config.journalPath))
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || (parent.mode & 0o077)) throw new Error('Private control directory required')
  if (dirname(config.socketPath) !== dirname(config.journalPath)) throw new Error('Control paths must share private directory')
  const helper = lstatSync(config.drainHelper)
  if (!helper.isFile() || helper.isSymbolicLink() || helper.uid !== 0 || (helper.mode & 0o022)) throw new Error('Root-owned input drain helper required')
  let broker: UnixInputBroker | undefined
  let disposed = false
  const approved = new Set<string>()
  const scopeKey = (scope: DesktopScope) => JSON.stringify([scope.workspaceId, scope.sessionId])
  const persistJournal = (record: InputArbiterJournal) => {
    const tmp = `${config.journalPath}.${randomUUID()}.tmp`
    writeFileSync(tmp, JSON.stringify(record), { mode: 0o600, flag: 'wx' })
    const fd = openSync(tmp, constants.O_RDONLY)
    try { fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(tmp, config.journalPath)
    const dir = openSync(dirname(config.journalPath), constants.O_RDONLY | constants.O_DIRECTORY)
    try { fsyncSync(dir) } finally { closeSync(dir) }
  }
  const arbiter = new InputArbiter({
    initialJournal: initial,
    persistJournal,
    cooperativeOwnerPresent: () => {
      const state = JSON.parse(privateFile(config.ownerFile))
      return !Object.hasOwn(state, 'owner') || state.owner !== null
    },
    legacyProxyActive: () => {
      if (!broker || disposed) return true
      const registered = broker.registrations()
      // Trusted local process inventory, never claimed renderer/PID evidence alone.
      for (const pid of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
        try {
          if (lstatSync(`/proc/${pid}`).uid !== process.getuid?.()) continue
          const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
          if (!args.includes(config.proxyPath)) continue
          const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
          const startTime = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
          if (!registered.some(p => p.pid === Number(pid) && p.startTime === startTime)) return true
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ESRCH') return true
        }
      }
      return false
    },
    authorizeHuman: (scope: HumanInputScope) => !disposed && approved.has(scopeKey(scope)) && authorized(scope),
  })
  const ready = createUnixInputBroker(arbiter, config.socketPath).then(value => { broker = value })
  const control: DesktopControlOptions = {
    arbiter,
    authorizeRpc: async (context, scope) => {
      if (!broker || disposed || context.workspaceId !== scope.workspaceId || !authorized(scope)) return false
      approved.add(scopeKey(scope))
      return true
    },
    entitlementExpiresAt: expiresAt,
    confirmInputDrained: () => new Promise<void>((resolve, reject) => {
      execFile(config.drainHelper, [], { cwd: '/tmp', timeout: 1500, maxBuffer: 1024, env: { PATH: '/usr/bin:/bin' } }, (error, stdout) => {
        if (error || stdout !== 'SCOVILLE_INPUT_DRAINED\n') reject(new Error('Desktop input drain not confirmed'))
        else resolve()
      })
    }),
  }
  return { control, ready, async dispose() { disposed = true; approved.clear(); await ready; await broker?.close() } }
}
