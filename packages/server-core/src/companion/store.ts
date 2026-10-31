import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, lstatSync, readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync } from 'node:fs'
import { join } from 'node:path'

export type Scope = 'read' | 'chat' | 'create' | 'existing-permissions'
export interface Device { id: string; hash: string; workspaceId: string; scopes: Scope[]; name: string; sessionIds: string[]; allSessions: boolean; consent: string }
function validateDevices(value: unknown): Device[] {
  const scopes = new Set(['read', 'chat', 'create', 'existing-permissions'])
  const validId = (s: unknown) => typeof s === 'string' && /^[A-Za-z0-9_-]{1,150}$/.test(s)
  if (!Array.isArray(value) || value.length > 1000) throw new Error('Invalid companion store')
  const ids = new Set<string>()
  for (const d of value) {
    if (!d || typeof d !== 'object' || typeof d.id !== 'string' || !/^[a-f0-9]{32}$/.test(d.id)
      || ids.has(d.id) || typeof d.hash !== 'string' || !/^[a-f0-9]{64}$/.test(d.hash)
      || !validId(d.workspaceId) || typeof d.name !== 'string' || d.name.length > 100
      || typeof d.consent !== 'string' || d.consent.length > 300 || typeof d.allSessions !== 'boolean'
      || !Array.isArray(d.scopes) || !d.scopes.includes('read') || d.scopes.some((s: unknown) => !scopes.has(s as string))
      || !Array.isArray(d.sessionIds) || d.sessionIds.some((id: unknown) => !validId(id))) throw new Error('Invalid companion store')
    ids.add(d.id)
  }
  return value
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
/** Secrets are 256-bit random values; only SHA-256 digests are persisted. Single server writer. */
export class CompanionStore {
  private devices: Device[] = []
  private codes = new Map<string, { workspaceId: string; scopes: Scope[]; sessionIds: string[]; allSessions: boolean; consent: string; expires: number }>()
  private file: string
  private failed = false
  constructor(readonly directory: string, private now = Date.now) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const dir = lstatSync(directory)
    if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077) || dir.uid !== process.getuid?.()) throw new Error('Companion directory must be owned by server user and mode 0700')
    this.file = join(directory, 'devices.json')
    try {
      const stat = lstatSync(this.file)
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== dir.uid) throw new Error('Unsafe companion store')
      this.devices = validateDevices(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch (e: any) { if (e.code !== 'ENOENT') throw e }
  }
  private save() {
    if (this.failed) throw new Error('Companion persistence unavailable')
    const temp = join(this.directory, `devices-${randomBytes(12).toString('hex')}.tmp`)
    try {
      writeFileSync(temp, JSON.stringify(this.devices), { mode: 0o600, flag: 'wx' })
      const fd = openSync(temp, 'r')
      try { fsyncSync(fd) } finally { closeSync(fd) }
      renameSync(temp, this.file)
      const dir = openSync(this.directory, 'r')
      try { fsyncSync(dir) } finally { closeSync(dir) }
    } catch (e) {
      // Persistence uncertainty disables this process's entire credential surface.
      this.failed = true
      this.codes.clear()
      throw e
    }
  }
  mint(workspaceId: string, options: { chat?: boolean; create?: boolean; existingPermissions?: boolean; sessionIds?: string[]; allSessions?: boolean } = {}) {
    if (this.failed) throw new Error('Companion persistence unavailable')
    for (const [key, value] of this.codes) if (value.expires <= this.now()) this.codes.delete(key)
    if (this.codes.size >= 100) throw new Error('Too many pending codes')
    const scopes: Scope[] = ['read']
    if (options.chat) scopes.push('chat')
    if (options.create) scopes.push('create')
    if (options.existingPermissions && options.chat) scopes.push('existing-permissions')
    if (!options.allSessions && !options.sessionIds?.length && !options.create) throw new Error('Explicit sessionIds or allSessions or create required')
    const consent = options.chat ? 'Chat can invoke tools available to target session under its existing permissions' : 'Read only'
    const code = `ce_${randomBytes(32).toString('base64url')}`
    this.codes.set(hash(code), { workspaceId, scopes, sessionIds: options.sessionIds ?? [], allSessions: options.allSessions === true, consent, expires: this.now() + 300_000 })
    return { code, expiresAt: this.now() + 300_000, workspaceId, scopes, consent }
  }
  enroll(code: string, name: string) {
    if (this.failed) throw new Error('Companion persistence unavailable')
    const digest = hash(code)
    const entry = [...this.codes].find(([key]) => equal(key, digest))
    if (!entry || entry[1].expires <= this.now()) return null
    if (this.devices.length >= 1000) throw new Error('Device limit reached')
    this.codes.delete(entry[0]) // consume synchronously, before any await
    const token = `cd_${randomBytes(32).toString('base64url')}`
    const device: Device = { id: randomBytes(16).toString('hex'), hash: hash(token), workspaceId: entry[1].workspaceId, scopes: entry[1].scopes, sessionIds: entry[1].sessionIds, allSessions: entry[1].allSessions, consent: entry[1].consent, name }
    this.devices.push(device)
    try { this.save() } catch (e) { this.devices.pop(); throw e }
    return { deviceId: device.id, deviceToken: token, workspaceId: device.workspaceId, scopes: device.scopes, consent: device.consent, sessionIds: device.sessionIds, allSessions: device.allSessions }
  }
  authenticate(token: string) { return this.failed ? undefined : this.devices.find(d => equal(d.hash, hash(token))) }
  allowSession(device: Device, id: string) {
    if (this.failed || !this.devices.includes(device)) throw new Error('Companion authorization unavailable')
    device.sessionIds.push(id)
    try { this.save() } catch (e) { device.sessionIds.pop(); throw e }
  }
  list() { if (this.failed) throw new Error('Companion persistence unavailable'); return this.devices.map(({ hash: _hash, ...rest }) => rest) }
  revoke(id: string) {
    if (this.failed) throw new Error('Companion persistence unavailable')
    const previous = this.devices
    this.devices = this.devices.filter(d => d.id !== id)
    this.save() // Never restore revoked authorization after a persistence failure.
    return previous.length !== this.devices.length
  }
}
