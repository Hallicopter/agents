import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync, chmodSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDesktopRuntime, effectiveVncPassword } from './desktop-runtime'
import type { SessionManager } from '@craft-agent/server-core/sessions'

const scope = { workspaceId: 'ws', sessionId: 's' }
const ctx = { workspaceId: 'ws', clientId: 'client', webContentsId: null }
const origin = 'https://desktop.example.test'
const renderer = 'http://localhost:5173'
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-runtime-'))
  const path = join(dir, 'config.json')
  const config = { origin, rpcOrigin: renderer, upstream: { host: '127.0.0.1', port: 5902, passwordFile: join(dir, 'not-read') }, entitlements: [{ ...scope, expiresAt: new Date(Date.now() + 60000).toISOString() }] }
  const save = () => writeFileSync(path, JSON.stringify(config), { mode: 0o600 })
  save()
  writeFileSync(`${path}.revoked`, '', { mode: 0o600 })
  const runtime = createDesktopRuntime(path)!
  const calls = { cancelProcessing: 0, deleteSession: 0 }
  const manager = { getSession: async (id: string) => id === 's' ? { workspaceId: 'ws' } : null, cancelProcessing: async () => { calls.cancelProcessing++ }, deleteSession: async () => { calls.deleteSession++ } } as unknown as SessionManager
  runtime.bind(manager)
  return { path, config, save, runtime, manager, calls, close: () => { runtime.dispose(); rmSync(dir, { recursive: true }) } }
}
test('deployment requires exact explicit entitlement, session membership and Origin; never reads secret for grant', async () => {
  const f = fixture()
  try {
    const issue = (id = 's', o = renderer, c = ctx) => f.runtime.gateway.issueRpcGrant(c, id, o, () => true)
    expect((await issue()).url).toBe('wss://desktop.example.test/api/desktop/view')
    await expect(issue('foreign')).rejects.toThrow()
    await expect(issue('s', 'http://localhost:5174')).rejects.toThrow()
    await expect(issue('s', renderer, { ...ctx, workspaceId: 'foreign' })).rejects.toThrow()
    f.config.entitlements[0]!.expiresAt = '2000-01-01T00:00:00Z'; f.save()
    await expect(issue()).rejects.toThrow()
  } finally { f.close() }
})
for (const method of ['cancelProcessing', 'deleteSession'] as const) test(`${method} revokes session permanently within process`, async () => {
  const f = fixture()
  try {
    await f.runtime.gateway.issueRpcGrant(ctx, 's', renderer, () => true)
    await f.manager[method]('s')
    await expect(f.runtime.gateway.issueRpcGrant(ctx, 's', renderer, () => true)).rejects.toThrow()
  } finally { f.close() }
})
test('unconfigured deployment stays absent', () => expect(createDesktopRuntime(undefined)).toBeUndefined())

test('journal failure fails desktop closed but still executes Stop/delete', async () => {
  for (const method of ['cancelProcessing', 'deleteSession'] as const) {
    const f = fixture()
    try {
      unlinkSync(`${f.path}.revoked`)
      await f.manager[method]('s')
      expect(f.calls[method]).toBe(1)
      await expect(f.runtime.gateway.issueRpcGrant(ctx, 's', renderer, () => true)).rejects.toThrow()
    } finally { f.close() }
  }
})
test('rejects permissive modes and symlink config/journal', async () => {
  const f = fixture()
  try {
    chmodSync(f.path, 0o644)
    expect(() => createDesktopRuntime(f.path)).toThrow()
    chmodSync(f.path, 0o600)
    const link = `${f.path}.link`; symlinkSync(f.path, link)
    expect(() => createDesktopRuntime(link)).toThrow()
    unlinkSync(`${f.path}.revoked`); symlinkSync(f.path, `${f.path}.revoked`)
    expect(() => createDesktopRuntime(f.path)).toThrow()
  } finally { f.close() }
})
for (const change of ['remove', 'journal', 'expiry'] as const) test(`post-await revalidates ${change}`, async () => {
  const f = fixture()
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  let markEntered!: () => void
  const entered = new Promise<void>(resolve => { markEntered = resolve })
  f.runtime.bind({ getSession: async () => { markEntered(); await wait; return { workspaceId: 'ws' } }, cancelProcessing: async () => {}, deleteSession: async () => {} } as unknown as SessionManager)
  try {
    const pending = f.runtime.gateway.issueRpcGrant(ctx, 's', renderer, () => true)
    await entered
    if (change === 'remove') { f.config.entitlements = []; f.save() }
    if (change === 'journal') writeFileSync(`${f.path}.revoked`, JSON.stringify('s') + '\n')
    if (change === 'expiry') { f.config.entitlements[0]!.expiresAt = '2000-01-01T00:00:00Z'; f.save() }
    release()
    await expect(pending).rejects.toThrow()
  } finally { release(); f.close() }
})
test('revocation survives runtime recreation', async () => {
  const f = fixture()
  try {
    await f.manager.cancelProcessing('s')
    f.runtime.dispose()
    const next = createDesktopRuntime(f.path)!
    next.bind(f.manager)
    try { await expect(next.gateway.issueRpcGrant(ctx, 's', renderer, () => true)).rejects.toThrow() } finally { next.dispose() }
  } finally { f.close() }
})

test('VncAuth adapter validates complete plaintext before effective eight-byte derivation', () => {
  expect(effectiveVncPassword('abcdefgh-synthetic-long')).toBe('abcdefgh')
  expect(effectiveVncPassword('abcdefgh\n')).toBe('abcdefgh')
  expect(effectiveVncPassword('abcdefgh\r\n')).toBe('abcdefgh')
  expect(effectiveVncPassword('short')).toBe('short')
  for (const raw of ['', 'abcdefgh\n\n', 'abcdefgh\rsuffix', 'abcdefgh\nsuffix', 'abcdefghé', 'abcdefgh\0', 'x'.repeat(129)]) expect(() => effectiveVncPassword(raw)).toThrow()
})
test('long ASCII adapter is challenge-equivalent to VNC eight-byte DES key', async () => {
  // @ts-expect-error upstream noVNC declarations absent
  const { DESECBCipher } = await import('@novnc/novnc/lib/crypto/des.js')
  const encrypt = async (password: string) => {
    const key = new Uint8Array(8); key.set(Buffer.from(password, 'ascii'))
    const cipher = DESECBCipher.importKey(key)
    return cipher.encrypt({}, new Uint8Array(16).fill(42))
  }
  expect(await encrypt(effectiveVncPassword('abcdefgh-extra\r\n'))).toEqual(await encrypt('abcdefgh'))
})
