import type { CompanionStore } from './store'

export interface SessionView { id: string; workspaceId: string; name?: string; isProcessing: boolean; lastMessageAt: number; parentSessionId?: string; hidden?: boolean; permissionMode?: string; sessionStatus?: string; messages?: Array<{ id: string; role: string; content: string; timestamp: number; hidden?: boolean }> }
export interface CompanionBackend {
  sessions(workspaceId: string): SessionView[]
  session(id: string): Promise<SessionView | null>
  create(workspaceId: string, name?: string): Promise<SessionView>
  send(id: string, text: string, allowExistingPermissions: boolean, authorize: () => void): Promise<void>
  pages(workspaceId: string): Promise<Array<{ slug: string; name: string; description?: string }>>
  page(workspaceId: string, slug: string): Promise<{ page: { slug: string; name: string; description?: string }; contentText: string; contentHtml?: string } | null>
}
// Defense in depth, not an assurance that arbitrary prose contains no confidential data.
export function redact(text: string) {
  return text.replace(/\b(?:ce_|cd_|sk-|ghp_|github_pat_)[A-Za-z0-9_\-]{16,}\b/g, '[REDACTED]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|password|secret|access[_-]?token|refresh[_-]?token)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
}
const summary = (s: SessionView) => ({ id: s.id, name: redact(s.name ?? 'Untitled'), isProcessing: s.isProcessing, lastMessageAt: s.lastMessageAt, permissionMode: s.permissionMode, sessionStatus: s.sessionStatus, ...(s.parentSessionId ? { parentSessionId: s.parentSessionId } : {}) })
const response = (status: number, body: unknown) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" } })
const ok = (data: unknown, status = 200) => response(status, { ok: true, data })
const fail = (status: number, code: string) => response(status, { ok: false, error: { code, message: code.replaceAll('_', ' ') } })
export function createCompanionHandler(store: CompanionStore, backend: CompanionBackend, now = Date.now) {
  let window = 0, count = 0, enrollmentCount = 0
  const deviceRates = new Map<string, { at: number; count: number }>()
  return async (req: Request): Promise<Response> => {
    try {
      const path = new URL(req.url).pathname
      // No cookies, CORS, query credentials, or browser-origin requests.
      if (req.headers.has('origin')) return fail(403, 'forbidden')
      if (now() - window >= 60_000) { window = now(); count = 0; enrollmentCount = 0; deviceRates.clear() }
      if (++count > 1000) return fail(429, 'rate_limited')
      const body = async () => {
        const text = await req.text()
        if (text.length > 16_384) throw new Error('invalid')
        const value = JSON.parse(text || '{}')
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid')
        return value
      }
      if (path === '/api/companion/v1/enroll' && req.method === 'POST') {
        if (++enrollmentCount > 10) return fail(429, 'rate_limited')
        const b = await body()
        if (typeof b.code !== 'string' || b.code.length > 100 || typeof b.deviceName !== 'string' || b.deviceName.length > 100) return fail(400, 'invalid_request')
        const enrolled = store.enroll(b.code, b.deviceName)
        return enrolled ? ok(enrolled) : fail(401, 'invalid_code')
      }
      const auth = req.headers.get('authorization') ?? ''
      const device = /^Bearer cd_[A-Za-z0-9_-]{43}$/.test(auth) ? store.authenticate(auth.slice(7)) : null
      if (!device) return fail(401, 'unauthorized')
      const rate = deviceRates.get(device.id) ?? { at: now(), count: 0 }
      deviceRates.set(device.id, rate)
      if (++rate.count > 120) return fail(429, 'rate_limited')
      const workspace = device.workspaceId
      const list = () => backend.sessions(workspace).filter(s => s.workspaceId === workspace && !s.hidden && (device.allSessions || device.sessionIds.includes(s.id)))
      const scopedSummary = (s: SessionView) => {
        const result = summary(s)
        if (result.parentSessionId && !list().some(p => p.id === result.parentSessionId)) delete result.parentSessionId
        return result
      }
      if (path === '/api/companion/v1/sessions') {
        if (req.method === 'GET') { const all = list(); return ok({ sessions: all.slice(0, 200).map(scopedSummary), truncated: all.length > 200 }) }
        if (req.method === 'POST') {
          if (!device.scopes.includes('create')) return fail(403, 'forbidden')
          const b = await body()
          if (Object.keys(b).some(k => k !== 'name') || (b.name !== undefined && (typeof b.name !== 'string' || b.name.length > 100))) return fail(400, 'invalid_request')
          if (!store.authenticate(auth.slice(7))) return fail(401, 'unauthorized')
          const created = await backend.create(workspace, b.name)
          if (!store.authenticate(auth.slice(7))) return fail(401, 'unauthorized')
          store.allowSession(device, created.id)
          return ok({ session: scopedSummary(created) }, 201)
        }
      }
      const match = path.match(/^\/api\/companion\/v1\/sessions\/([A-Za-z0-9_-]{1,150})(?:\/(messages|subagents))?$/)
      if (match) {
        const id = match[1]!
        if (!list().some(s => s.id === id)) return fail(404, 'not_found')
        if (req.method === 'GET' && match[2] === 'subagents') { const children = list().filter(s => s.parentSessionId === id); return ok({ sessions: children.slice(0, 200).map(scopedSummary), truncated: children.length > 200 }) }
        if (req.method === 'GET' && !match[2]) {
          const s = await backend.session(id)
          if (!store.authenticate(auth.slice(7))) return fail(401, 'unauthorized')
          if (!list().some(s => s.id === id)) return fail(404, 'not_found')
          if (!s || s.workspaceId !== workspace) return fail(404, 'not_found')
          const messages = (s.messages ?? []).filter(m => !m.hidden && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
          return ok({ session: scopedSummary(s), messages: messages.slice(-100).map(m => ({ id: m.id, role: m.role, content: redact(m.content.slice(0, 16_000)), timestamp: m.timestamp })), truncated: messages.length > 100 || messages.some(m => m.content.length > 16_000) })
        }
        if (req.method === 'POST' && match[2] === 'messages') {
          if (!device.scopes.includes('chat')) return fail(403, 'forbidden')
          const target = await backend.session(id)
          if (!target || target.workspaceId !== workspace) return fail(404, 'not_found')
          if (target.permissionMode !== 'safe' && !device.scopes.includes('existing-permissions')) return fail(403, 'existing_permissions_required')
          const b = await body()
          if (typeof b.text !== 'string' || !b.text.trim() || b.text.length > 12_000 || Object.keys(b).some(k => k !== 'text')) return fail(400, 'invalid_request')
          if (!store.authenticate(auth.slice(7))) return fail(401, 'unauthorized')
          const authorize = () => {
            const current = store.authenticate(auth.slice(7))
            const target = backend.sessions(workspace).find(s => s.id === id && s.workspaceId === workspace && !s.hidden)
            if (!current || current.workspaceId !== workspace || !current.scopes.includes('chat')
              || (!current.allSessions && !current.sessionIds.includes(id)) || !target
              || (target.permissionMode !== 'safe' && !current.scopes.includes('existing-permissions'))) throw new Error('Companion authorization expired')
          }
          authorize()
          await backend.send(id, b.text, device.scopes.includes('existing-permissions'), authorize)
          return ok({ accepted: true }, 202)
        }
      }
      if (req.method === 'GET' && path === '/api/companion/v1/pages') { const pages = await backend.pages(workspace); if (!store.authenticate(auth.slice(7))) return fail(401, 'unauthorized'); return ok({ pages: pages.slice(0, 200).map(p => ({ slug: p.slug, name: redact(p.name), description: redact(p.description ?? '') })), truncated: pages.length > 200 }) }
      const page = path.match(/^\/api\/companion\/v1\/pages\/([a-z0-9][a-z0-9-]{0,99})$/)
      if (req.method === 'GET' && page) {
        const data = await backend.page(workspace, page[1]!)
        if (!store.authenticate(auth.slice(7))) return fail(401, 'unauthorized')
        return data ? ok({ page: { slug: data.page.slug, name: redact(data.page.name), description: redact(data.page.description ?? '') }, contentText: redact(data.contentText.slice(0, 100_000)), ...(data.contentHtml ? { contentHtml: redact(data.contentHtml).length <= 250_000 ? redact(data.contentHtml) : undefined } : {}) }) : fail(404, 'not_found')
      }
      return fail(404, 'not_found')
    } catch { return fail(400, 'invalid_request') }
  }
}
