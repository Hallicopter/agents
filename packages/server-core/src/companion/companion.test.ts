import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { companionNodeHandler } from './node-http'
import { staticPageHtml } from './page-html'
import { CompanionStore } from './store'
import { createCompanionHandler, type CompanionBackend, type SessionView } from './http'

let root: string, time: number, store: CompanionStore
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'companion-test-')); time = 1_000_000; store = new CompanionStore(join(root, 'private'), () => time) })
afterEach(() => rmSync(root, { recursive: true, force: true }))
describe('device enrollment', () => {
  it('consumes single-use code, persists hashes only and survives reload', () => {
    const minted = store.mint('ws', { allSessions: true })
    const d = store.enroll(minted.code, 'phone')!
    expect(store.enroll(minted.code, 'replay')).toBeNull()
    expect(store.authenticate(minted.code)).toBeUndefined()
    expect(store.authenticate(d.deviceToken)?.workspaceId).toBe('ws')
    const raw = readFileSync(join(root, 'private/devices.json'), 'utf8')
    expect(raw.includes(d.deviceToken)).toBe(false)
    expect(raw.includes(minted.code)).toBe(false)
    expect(statSync(join(root, 'private/devices.json')).mode & 0o777).toBe(0o600)
    expect(new CompanionStore(join(root, 'private')).authenticate(d.deviceToken)?.id).toBe(d.deviceId)
    expect(store.revoke(d.deviceId)).toBe(true)
    expect(store.authenticate(d.deviceToken)).toBeUndefined()
    expect(new CompanionStore(join(root, 'private')).authenticate(d.deviceToken)).toBeUndefined()
  })
  it('expires at five minutes and rejects unscoped mint', () => {
    expect(() => store.mint('ws')).toThrow()
    const m = store.mint('ws', { sessionIds: ['one'] })
    time += 300_000
    expect(store.enroll(m.code, 'phone')).toBeNull()
  })
  it('requires owner-only directory and refuses symlinks', () => {
    mkdirSync(join(root, 'public'), { mode: 0o755 })
    expect(() => new CompanionStore(join(root, 'public'))).toThrow()
    symlinkSync(join(root, 'private'), join(root, 'link'))
    expect(() => new CompanionStore(join(root, 'link'))).toThrow()
  })
})
function fixture(options: Parameters<CompanionStore['mint']>[1] = { sessionIds: ['one'] }) {
  const sessions: SessionView[] = [
    { id: 'one', workspaceId: 'ws', name: 'One', isProcessing: false, lastMessageAt: 1, permissionMode: 'safe', messages: [
      { id: 'u', role: 'user', content: 'hello', timestamp: 1 },
      { id: 'h', role: 'user', hidden: true, content: 'HIDDEN_SYSTEM_PROMPT', timestamp: 2 },
      { id: 't', role: 'tool', content: 'VERY_SECRET_RAW_TOOL', timestamp: 2 },
      { id: 'a', role: 'assistant', content: 'Bearer abcdef1234567890', timestamp: 3 },
    ] },
    { id: 'other', workspaceId: 'ws', name: 'Other', isProcessing: false, lastMessageAt: 2, parentSessionId: 'one', permissionMode: 'allow-all' },
    { id: 'foreign', workspaceId: 'elsewhere', isProcessing: false, lastMessageAt: 3 },
  ]
  let sends = 0, creates = 0
  const backend: CompanionBackend = {
    sessions: () => sessions, session: async id => sessions.find(s => s.id === id) ?? null,
    create: async workspaceId => { creates++; const s = { id: 'created', workspaceId, isProcessing: false, lastMessageAt: 4, permissionMode: 'safe' }; sessions.push(s); return s },
    send: async () => { sends++ },
    pages: async () => [{ slug: 'demo', name: 'Demo', grants: 'HIDDEN_GRANT', secret: 'HIDDEN_SECRET' } as any],
    page: async () => ({ page: { slug: 'demo', name: 'Demo', grants: 'HIDDEN_GRANT' } as any, contentText: 'Hello', secret: 'HIDDEN_SECRET' } as any),
  }
  const handler = createCompanionHandler(store, backend, () => time)
  const minted = store.mint('ws', options)
  const device = store.enroll(minted.code, 'phone')!
  const call = (path: string, method = 'GET', body?: any, headers: Record<string, string> = {}) => handler(new Request(`https://test/api/companion/v1${path}`, { method, headers: { Authorization: `Bearer ${device.deviceToken}`, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }))
  return { handler, device, call, sessions, counts: () => ({ sends, creates }) }
}
describe('allowlisted facade', () => {
  it('denies cross-workspace and ungranted session IDs, filters children', async () => {
    const f = fixture()
    expect(((await (await f.call('/sessions')).json()) as any).data.sessions.map((s: any) => s.id)).toEqual(['one'])
    expect((await f.call('/sessions/foreign')).status).toBe(404)
    expect((await f.call('/sessions/other')).status).toBe(404)
    expect(((await (await f.call('/sessions/one/subagents')).json()) as any).data.sessions).toEqual([])
    expect((await f.call('/sessions/one/messages', 'POST', { text: 'hi' })).status).toBe(403)
    expect((await f.call('/sessions', 'POST', {})).status).toBe(403)
  })
  it('requires separate high-permission consent and never changes session mode', async () => {
    const f = fixture({ allSessions: true, chat: true })
    expect((await f.call('/sessions/one/messages', 'POST', { text: 'hi' })).status).toBe(202)
    expect((await f.call('/sessions/other/messages', 'POST', { text: 'hi' })).status).toBe(403)
    expect(f.counts().sends).toBe(1)
    expect(f.sessions[1]!.permissionMode).toBe('allow-all')
    const g = fixture({ allSessions: true, chat: true, existingPermissions: true })
    expect((await g.call('/sessions/other/messages', 'POST', { text: 'hi' })).status).toBe(202)
    expect(store.list().some(d => d.consent.includes('Chat can invoke tools'))).toBe(true)
  })
  it('adds created sessions to scope but rejects mode/source injection', async () => {
    const f = fixture({ create: true })
    expect((await f.call('/sessions', 'POST', { permissionMode: 'allow-all' })).status).toBe(400)
    expect((await f.call('/sessions', 'POST', { name: 'Mobile' })).status).toBe(201)
    expect((await f.call('/sessions/created')).status).toBe(200)
    expect((await f.call('/sessions/one')).status).toBe(404)
  })
  it('does not serialize tools, raw session data, Page grants or source actions', async () => {
    const f = fixture()
    ;(f.sessions[0] as any).workingDirectory = '/private/credentials'
    const detail = await (await f.call('/sessions/one')).text()
    expect(detail).not.toContain('VERY_SECRET_RAW_TOOL')
    expect(detail).not.toContain('HIDDEN_SYSTEM_PROMPT')
    expect(detail).not.toContain('/private/credentials')
    expect(detail).not.toContain('abcdef1234567890')
    for (const path of ['/pages', '/pages/demo']) {
      const text = await (await f.call(path)).text()
      expect(text).not.toContain('HIDDEN_')
    }
    for (const path of ['/sources', '/admin/mint', '/pages/demo/actions', '/sessions/one/permissions', '/pages/%2e%2e']) expect((await f.call(path, 'POST', {})).status).toBe(404)
  })
  it('revokes immediately, refuses browser origins and rate limits', async () => {
    const f = fixture()
    expect((await f.call('/sessions', 'GET', undefined, { Origin: 'https://evil.test' })).status).toBe(403)
    for (let i = 0; i < 120; i++) expect((await f.call('/sessions')).status).toBe(200)
    expect((await f.call('/sessions')).status).toBe(429)
    time += 60_001
    expect((await f.call('/sessions')).status).toBe(200)
    store.revoke(f.device.deviceId)
    expect((await f.call('/sessions')).status).toBe(401)
  })
  it('bounds history and rejects excess message options', async () => {
    const f = fixture({ sessionIds: ['one'], chat: true })
    f.sessions[0]!.messages = Array.from({ length: 110 }, (_, i) => ({ id: `${i}`, role: 'assistant', content: 'x'.repeat(17000), timestamp: i }))
    const body: any = await (await f.call('/sessions/one')).json()
    expect(body.data.messages.length).toBe(100)
    expect(body.data.messages[0].content.length).toBe(16000)
    expect(body.data.truncated).toBe(true)
    expect((await f.call('/sessions/one/messages', 'POST', { text: 'hi', enabledSourceSlugs: ['secret'] })).status).toBe(400)
  })
  it('rate limits enrollment independently and handles malformed bodies', async () => {
    const f = fixture()
    for (let i = 0; i < 10; i++) expect((await f.call('/enroll', 'POST', { code: 'bad', deviceName: 'phone' })).status).toBe(401)
    expect((await f.call('/enroll', 'POST', { code: 'bad', deviceName: 'phone' })).status).toBe(429)
  })
})

describe('HTTP enrollment protocol', () => {
  it('enrolls exactly once without accepting administrator credentials or cookies', async () => {
    const f = fixture()
    const minted = store.mint('ws', { sessionIds: ['one'] })
    const enroll = () => f.handler(new Request('https://test/api/companion/v1/enroll', { method: 'POST', body: JSON.stringify({ code: minted.code, deviceName: 'Android' }) }))
    const first = await enroll()
    expect(first.status).toBe(200)
    const token = ((await first.json()) as any).data.deviceToken
    expect(token.startsWith('cd_')).toBe(true)
    expect((await enroll()).status).toBe(401)
    for (const headers of ([{ Authorization: 'Bearer administrative-token' }, { Cookie: 'session=some-webui-jwt' }, { Authorization: `Bearer ${minted.code}` }] as Record<string, string>[])) {
      const result = await f.handler(new Request('https://test/api/companion/v1/sessions', { headers }))
      expect(result.status).toBe(401)
    }
    const authenticated = await f.handler(new Request('https://test/api/companion/v1/sessions', { headers: { Authorization: `Bearer ${token}` } }))
    expect(authenticated.status).toBe(200)
    expect(authenticated.headers.get('cache-control')).toBe('no-store')
  })
})


describe('additional confinement regressions', () => {
  it('rejects tampered persisted scope types rather than treating strings as truthy', () => {
    fixture()
    const path = join(root, 'private/devices.json')
    const original = JSON.parse(readFileSync(path, 'utf8'))
    for (const patch of [{ allSessions: 'false' }, { scopes: ['admin'] }, { sessionIds: [42] }, { hash: 'bad' }, { workspaceId: null }, { consent: {} }]) {
      writeFileSync(path, JSON.stringify([{ ...original[0], ...patch }]))
      expect(() => new CompanionStore(join(root, 'private'))).toThrow()
    }
  })
  it('omits an out-of-scope parent and denies session mode escalation on next send', async () => {
    const f = fixture({ sessionIds: ['other'], chat: true })
    const body: any = await (await f.call('/sessions')).json()
    expect(body.data.sessions[0].parentSessionId).toBeUndefined()
    f.sessions[1]!.permissionMode = 'safe'
    expect((await f.call('/sessions/other/messages', 'POST', { text: 'safe' })).status).toBe(202)
    f.sessions[1]!.permissionMode = 'allow-all'
    expect((await f.call('/sessions/other/messages', 'POST', { text: 'unsafe' })).status).toBe(403)
    expect(f.counts().sends).toBe(1)
  })
  it('passes busy-session sends to backend without forcing mode changes', async () => {
    const f = fixture({ sessionIds: ['one'], chat: true })
    f.sessions[0]!.isProcessing = true
    expect((await f.call('/sessions/one/messages', 'POST', { text: 'followup' })).status).toBe(202)
    expect(f.sessions[0]!.permissionMode).toBe('safe')
    expect(f.counts().sends).toBe(1)
  })
  it('returns enrollment consent and session scope, rejects encoded escape paths', async () => {
    const f = fixture()
    const minted = store.mint('ws', { sessionIds: ['one'], chat: true })
    const enrolled: any = await (await f.call('/enroll', 'POST', { code: minted.code, deviceName: 'Phone' })).json()
    expect(enrolled.data.sessionIds).toEqual(['one'])
    expect(enrolled.data.allSessions).toBe(false)
    expect(enrolled.data.consent).toContain('Chat can invoke tools')
    for (const path of ['/sessions/one%2fmessages', '/pages/%2e%2e%2fsecret', '/pages/x%00', '/sessions/%2e%2e']) expect((await f.call(path)).status).toBe(404)
  })
  it('strips active HTML while preserving static layout and supplies defense-in-depth CSP', async () => {
    const html = await staticPageHtml('<html><head><style>body{color:red}</style><script>RAW_SCRIPT_SECRET</script></head><body><h1>Report</h1><a href="https://evil">Link</a><iframe src="https://evil"></iframe><img src="https://evil" onerror="alert(1)" onclick="evil()"><img src="data:image/png;base64,YQ=="><form action="https://evil"><input value="hidden"></form></body></html>')
    expect(html).toContain('<h1>Report</h1>')
    expect(html).toContain('body{color:red}')
    expect(html).toContain('Content-Security-Policy')
    expect(html).toContain('data:image/png;base64,YQ==')
    for (const bad of ['RAW_SCRIPT_SECRET', 'https://evil', '<script', '<iframe', 'onerror', 'onclick', '<form', '<input']) expect(html).not.toContain(bad)
    expect(await staticPageHtml('x'.repeat(512001))).toBeUndefined()
  })
})


describe('same-listener HTTP adapter (in-memory streams, no ports)', () => {
  function request(encrypted: boolean, body: string, handler: ((r: Request) => Promise<Response>) | null, rawHeaders: string[] = []) {
    return new Promise<{ status: number; body: string }>(resolve => {
      const req = Readable.from([Buffer.from(body)]) as any
      Object.assign(req, { method: 'POST', url: '/api/companion/v1/enroll', rawHeaders, socket: { encrypted }, setTimeout() {} })
      let status = 0
      const res: any = { headersSent: false, setHeader() {}, writeHead(code: number) { status = code; this.headersSent = true }, end(value: string = '') { resolve({ status, body: value }) } }
      companionNodeHandler(() => handler)(req, res)
    })
  }
  it('refuses plaintext despite spoofed forwarded proto and fails closed while starting', async () => {
    expect((await request(false, '', null, ['X-Forwarded-Proto', 'https'])).status).toBe(426)
    expect((await request(true, '', null)).status).toBe(503)
  })
  it('caps bytes before the handler and preserves request method/body/authorization', async () => {
    let calls = 0
    const handler = async (r: Request) => { calls++; expect(r.method).toBe('POST'); expect(r.headers.get('authorization')).toBe('Bearer test'); expect(await r.json()).toEqual({ code: 'x' }); return Response.json({ ok: true }, { status: 201 }) }
    expect((await request(true, 'x'.repeat(16385), handler)).status).toBe(413)
    expect(calls).toBe(0)
    expect((await request(true, JSON.stringify({ code: 'x' }), handler, ['Authorization', 'Bearer test'])).status).toBe(201)
    expect(calls).toBe(1)
  })
})

describe('revocation across pending operations', () => {
  for (const route of ['/sessions/one', '/pages', '/pages/demo']) {
    it(`denies a pending ${route} read after revoke`, async () => {
      const minted = store.mint('ws', { sessionIds: ['one'] })
      const d = store.enroll(minted.code, 'test')!
      let release!: () => void
      let entered!: () => void
      const started = new Promise<void>(r => entered = r)
      const gate = new Promise<void>(r => release = r)
      const wait = async () => { entered(); await gate }
      const session: SessionView = { id: 'one', workspaceId: 'ws', isProcessing: false, lastMessageAt: 0, permissionMode: 'safe', messages: [{ id: 'm', role: 'assistant', content: 'SENSITIVE_PENDING', timestamp: 0 }] }
      const backend: CompanionBackend = {
        sessions: () => [session], session: async () => { await wait(); return session },
        create: async () => session, send: async () => {},
        pages: async () => { await wait(); return [{ slug: 'demo', name: 'SENSITIVE_PENDING' }] },
        page: async () => { await wait(); return { page: { slug: 'demo', name: 'Demo' }, contentText: 'SENSITIVE_PENDING' } },
      }
      const handler = createCompanionHandler(store, backend, () => time)
      const pending = handler(new Request(`https://test/api/companion/v1${route}`, { headers: { Authorization: `Bearer ${d.deviceToken}` } }))
      await started
      store.revoke(d.deviceId)
      release()
      const result = await pending
      expect(result.status).toBe(401)
      expect(await result.text()).not.toContain('SENSITIVE_PENDING')
    })
  }
  it('fails closed on persistence error without restoring revoked authorization', () => {
    const d = store.enroll(store.mint('ws', { sessionIds: ['one'] }).code, 'test')!
    const device = store.authenticate(d.deviceToken)!
    rmSync(join(root, 'private'), { recursive: true, force: true })
    expect(() => store.revoke(d.deviceId)).toThrow()
    expect(store.authenticate(d.deviceToken)).toBeUndefined()
    expect(() => store.mint('ws', { sessionIds: ['one'] })).toThrow()
    expect(() => store.enroll('invalid', 'test')).toThrow()
    expect(() => store.allowSession(device, 'new')).toThrow()
    expect(() => store.list()).toThrow()
    expect(() => store.revoke(d.deviceId)).toThrow()
  })
})

describe('admin socket lifecycle', () => {
  it('cleans only its owned socket on normal close and can restart', async () => {
    const { startCompanionAdmin } = await import('./admin')
    const first = await startCompanionAdmin(store, () => true)
    await new Promise<void>((resolve, reject) => first.close(e => e ? reject(e) : resolve()))
    const second = await startCompanionAdmin(store, () => true)
    await new Promise<void>((resolve, reject) => second.close(e => e ? reject(e) : resolve()))
    expect(() => statSync(join(root, 'private/admin.sock'))).toThrow()
  })
})

describe('dispatch authorization callback', () => {
  for (const change of ['revoked', 'elevated'] as const) {
    it(`denies deferred dispatch when ${change}`, async () => {
      const session: SessionView = { id: 'one', workspaceId: 'ws', isProcessing: false, lastMessageAt: 0, permissionMode: 'safe' }
      const d = store.enroll(store.mint('ws', { sessionIds: ['one'], chat: true }).code, 'test')!
      let guard!: () => void
      const backend: CompanionBackend = {
        sessions: () => [session], session: async () => session, create: async () => session,
        send: async (_id, _text, _existing, authorize) => { guard = authorize; authorize() },
        pages: async () => [], page: async () => null,
      }
      const handler = createCompanionHandler(store, backend, () => time)
      const result = await handler(new Request('https://test/api/companion/v1/sessions/one/messages', { method: 'POST', headers: { Authorization: `Bearer ${d.deviceToken}` }, body: JSON.stringify({ text: 'test' }) }))
      expect(result.status).toBe(202)
      expect(typeof guard).toBe('function')
      if (change === 'revoked') store.revoke(d.deviceId)
      else session.permissionMode = 'allow-all'
      expect(guard).toThrow()
    })
  }
})
