import { randomBytes } from 'node:crypto'
import { connect, isIP, type Socket } from 'node:net'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket, type RawData } from 'ws'
// noVNC's VNC-compatible DES bit ordering; password never crosses the gateway.
// @ts-expect-error noVNC does not ship declarations
import { DESECBCipher } from '@novnc/novnc/lib/crypto/des.js'
import type { RequestContext } from '../transport/types'
import { WatchServerGate } from './rfb-server'
import { WatchRfbGate } from './rfb-watch'

export const DESKTOP_PATH = '/api/desktop/view'
export interface DesktopScope { workspaceId: string; sessionId: string }
export interface DesktopGatewayOptions {
  /** Exact browser origin, HTTPS only. Never inferred from proxy headers. */
  origin: string
  /** Fixed operator-provisioned IP: loopback SSH tunnel or private tailnet IPv4. */
  upstream: { host: string; port: number; password: () => Promise<string> }
  /** Authenticate request AND check configured desktop entitlement/session existence.
   * Must return false after logout/session stop/deletion or entitlement removal.
   * Generic webui login alone is NOT sufficient. */
  authorize: (headers: Headers, scope: DesktopScope) => Promise<boolean>
  /** Explicit deployment assertion: existing trusted ingress terminates TLS.
   * Otherwise only encrypted incoming sockets are accepted. */
  trustedTlsIngress?: boolean
  /** Explicit Electron file origin allowed only for RPC-issued grants. */
  electronOrigin?: 'null' | 'file://'
  /** Exact dev renderer origin. HTTP is restricted to literal loopback/localhost. */
  rpcOrigin?: string
  authorizeRpc?: (context: RequestContext, scope: DesktopScope) => Promise<boolean>
}
interface Grant { scope: DesktopScope; validate: () => Promise<boolean>; origin: string; expires: number }
const unavailable = () => Response.json({ error: 'Desktop unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
export { unavailable as desktopUnavailable }

/** Opt-in gateway; constructor does not listen or read configuration/credentials.
 * One fixed desktop, at most two viewers, 30s single-use grants, 5min streams.
 */
export class DesktopGateway {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false })
  private readonly grants = new Map<string, Grant>()
  private readonly viewers = new Map<WebSocket, DesktopScope | null>()
  private disposed = false
  constructor(private readonly options: DesktopGatewayOptions) {
    const origin = new URL(options.origin)
    if (origin.protocol !== 'https:' || origin.origin !== options.origin) throw new Error('Exact HTTPS desktop origin required')
    if (options.rpcOrigin) {
      const renderer = new URL(options.rpcOrigin)
      if (renderer.origin !== options.rpcOrigin || (renderer.protocol !== 'https:' &&
          !(renderer.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(renderer.hostname)))) throw new Error('Exact secure or loopback renderer origin required')
    }
    const { host, port } = options.upstream
    const parts = host.split('.').map(Number)
    const allowed = host === '127.0.0.1' || (parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127)
    if (isIP(host) !== 4 || !allowed || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Private fixed desktop endpoint required')
  }
  async fetch(req: Request): Promise<Response> {
    if ((new URL(req.url).protocol !== 'https:' && !this.options.trustedTlsIngress) || this.disposed || req.headers.get('origin') !== this.options.origin || new URL(req.url).search || req.method !== 'POST') return unavailable()
    if (new URL(req.url).pathname !== '/api/desktop/grant') return unavailable()
    // Body size is bounded before parsing, including chunked requests.
    const reader = req.body?.getReader()
    let body = ''
    if (!reader) return unavailable()
    try {
      let bytes = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.length
        if (bytes > 1024) { await reader.cancel(); return unavailable() }
        body += new TextDecoder().decode(value)
      }
      const scope = JSON.parse(body) as DesktopScope
      if (!scope || typeof scope.workspaceId !== 'string' || typeof scope.sessionId !== 'string' ||
          !scope.workspaceId || !scope.sessionId || scope.workspaceId.length > 200 || scope.sessionId.length > 200) return unavailable()
      if (!await boundedAuthorization(() => this.options.authorize(req.headers, scope))) return unavailable()
      for (const [key, grant] of this.grants) if (grant.expires <= Date.now()) this.grants.delete(key)
      if (this.grants.size >= 16 || this.disposed) return unavailable()
      const token = randomBytes(32).toString('base64url')
      this.grants.set(token, { scope: { workspaceId: scope.workspaceId, sessionId: scope.sessionId }, validate: () => boundedAuthorization(() => this.options.authorize(req.headers, scope)), origin: this.options.origin, expires: Date.now() + 30_000 })
      return Response.json({ token }, { headers: { 'Cache-Control': 'no-store' } })
    } catch { return unavailable() }
  }
  async issueRpcGrant(context: RequestContext, sessionId: string, origin: string, connected: () => boolean): Promise<{ token: string; url: string }> {
    if (!context.workspaceId || typeof origin !== 'string' || typeof sessionId !== 'string' || !sessionId || sessionId.length > 200 ||
        (origin !== this.options.origin && origin !== this.options.rpcOrigin && (!this.options.electronOrigin || origin !== this.options.electronOrigin))) throw new Error('Desktop unavailable')
    const scope = { workspaceId: context.workspaceId, sessionId }
    const validate = async () => connected() && !!await boundedAuthorization(async () => !!await this.options.authorizeRpc?.(context, scope))
    if (!await validate() || this.disposed) throw new Error('Desktop unavailable')
    for (const [key, grant] of this.grants) if (grant.expires <= Date.now()) this.grants.delete(key)
    if (this.grants.size >= 16) throw new Error('Desktop unavailable')
    const token = randomBytes(32).toString('base64url')
    this.grants.set(token, { scope, origin, validate, expires: Date.now() + 30_000 })
    return { token, url: `${this.options.origin.replace('https:', 'wss:')}${DESKTOP_PATH}` }
  }
  /** Call only from the existing ingress's upgrade dispatcher; never open a port. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const secure = (req.socket as Socket & { encrypted?: boolean }).encrypted || this.options.trustedTlsIngress === true
    if (this.disposed || !secure || req.url !== DESKTOP_PATH || (req.headers.origin !== this.options.origin && (!this.options.rpcOrigin || req.headers.origin !== this.options.rpcOrigin) && (!this.options.electronOrigin || req.headers.origin !== this.options.electronOrigin)) || this.viewers.size >= 2) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return
    }
    this.wss.handleUpgrade(req, socket, head, ws => {
      this.viewers.set(ws, null)
      const deadline = setTimeout(() => ws.terminate(), 5000)
      ws.once('close', () => { clearTimeout(deadline); this.viewers.delete(ws) })
      ws.on('error', () => ws.close())
      // Grant travels in the first frame, never a URL, subprotocol or log.
      ws.once('message', async (raw, binary) => {
        const data = rawBuffer(raw)
        try {
          if (binary || data.length > 512) throw new Error()
          const { token } = JSON.parse(data.toString())
          const grant = this.grants.get(token)
          this.grants.delete(token)
          if (!grant || grant.expires <= Date.now() || req.headers.origin !== grant.origin) throw new Error()
          this.viewers.set(ws, grant.scope)
          if (!await grant.validate() || grant.expires <= Date.now() || ws.readyState !== 1 || this.disposed) throw new Error()
          clearTimeout(deadline)
          this.stream(ws, grant)
        } catch { ws.close(1008, 'Desktop unavailable') }
      })
    })
  }
  revoke(scope: DesktopScope): void {
    for (const [key, grant] of this.grants) if (sameScope(scope, grant.scope)) this.grants.delete(key)
    for (const [ws, active] of this.viewers) if (active && sameScope(scope, active)) ws.terminate()
  }
  dispose(): void {
    this.disposed = true
    this.grants.clear()
    for (const ws of this.viewers.keys()) ws.terminate()
    this.wss.close()
  }
  private stream(ws: WebSocket, grant: Grant): void {
    const upstream = connect(this.options.upstream.port, this.options.upstream.host)
    const reader = new ExactReader(upstream)
    const gate = new WatchRfbGate()
    const serverGate = new WatchServerGate()
    let step = 0
    let ready = false
    let queued = 0
    let chain = Promise.resolve()
    const close = () => { upstream.destroy(); ws.close(1008, 'Desktop unavailable') }
    const handshake = setTimeout(close, 10_000)
    const lifetime = setTimeout(close, 5 * 60_000)
    let checking = false
    const revocation = setInterval(async () => {
      if (checking) return
      checking = true
      try { if (!await grant.validate()) close() } catch { close() }
      finally { checking = false }
    }, 1000)
    ws.once('close', () => { clearTimeout(handshake); clearTimeout(lifetime); clearInterval(revocation); upstream.destroy() })
    upstream.on('error', close)
    upstream.on('close', () => ws.close(1000, 'Desktop disconnected'))
    const send = (data: Buffer) => {
      if (ws.readyState !== 1 || ws.bufferedAmount > 4 * 1024 * 1024) { close(); return }
      ws.send(data, { binary: true })
    }
    ws.on('message', (raw, binary) => {
      const data = rawBuffer(raw)
      // Do not queue unbounded async parser work; bounded ws frame + one pending frame.
      if (!binary || !ready || queued + data.length > 65536) { close(); return }
      queued += data.length
      chain = chain.then(async () => {
        for (const msg of gate.push(Buffer.from(data as Buffer))) {
          if (step === 0) { send(Buffer.from([1, 1])); step++ }
          else if (step === 1) { send(Buffer.alloc(4)); step++ }
          else if (step === 2) {
            upstream.write(Buffer.from([1])) // ALWAYS shared, never evict other clients
            const init = await reader.read(24)
            const nameSize = init.readUInt32BE(20)
            if (nameSize > 4096 || init.readUInt16BE(0) > 8192 || init.readUInt16BE(2) > 8192) throw new Error()
            await reader.read(nameSize)
            // Do not expose upstream desktop title (may contain host/account metadata).
            const name = Buffer.from('Private desktop — watch only')
            init.writeUInt32BE(name.length, 20)
            send(Buffer.concat([init, name]))
            reader.pipe(data => {
              try { for (const packet of serverGate.push(data)) send(packet) } catch { close() }
            })
            clearTimeout(handshake)
            step++
          } else {
            if (upstream.writableLength > 65536) throw new Error()
            upstream.write(msg)
          }
        }
        queued -= data.length
      }).catch(close)
    })
    void (async () => {
      if ((await reader.read(12)).toString() !== 'RFB 003.008\n') throw new Error()
      upstream.write(Buffer.from('RFB 003.008\n'))
      const count = (await reader.read(1))[0]!
      if (!count || count > 32 || !(await reader.read(count)).includes(2)) throw new Error()
      upstream.write(Buffer.from([2]))
      const challenge = await reader.read(16)
      const password = await this.options.upstream.password()
      if (!password || password.length > 8 || /[^\x20-\x7e]/.test(password)) throw new Error()
      const key = new Uint8Array(8)
      key.set(Buffer.from(password, 'ascii'))
      const cipher = DESECBCipher.importKey(key)
      upstream.write(Buffer.from(cipher.encrypt({}, challenge)))
      key.fill(0)
      if ((await reader.read(4)).readUInt32BE(0) !== 0 || ws.readyState !== 1) throw new Error()
      ready = true
      // Acknowledge first: renderer attaches noVNC before requesting RFB greeting.
      ws.send(JSON.stringify({ ready: true }))
      send(Buffer.from('RFB 003.008\n'))
    })().catch(close)
  }
}
function sameScope(a: DesktopScope, b: DesktopScope): boolean { return a.workspaceId === b.workspaceId && a.sessionId === b.sessionId }

class ExactReader {
  private buffer = Buffer.alloc(0)
  private waiter: (() => void) | null = null
  private closed = false
  private sink: ((data: Buffer) => void) | null = null
  constructor(socket: Socket) {
    socket.on('data', raw => {
      const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
      if (this.sink) { this.sink(data); return }
      if (this.buffer.length + data.length > 65536) { socket.destroy(); return }
      this.buffer = Buffer.concat([this.buffer, data]); this.waiter?.()
    })
    socket.on('close', () => { this.closed = true; this.waiter?.() })
    socket.on('error', () => { this.closed = true; this.waiter?.() })
  }
  async read(size: number): Promise<Buffer> {
    while (this.buffer.length < size) {
      if (this.closed) throw new Error('Desktop disconnected')
      await new Promise<void>(resolve => { this.waiter = resolve })
      this.waiter = null
    }
    const result = Buffer.from(this.buffer.subarray(0, size)); this.buffer = this.buffer.subarray(size); return result
  }
  pipe(sink: (data: Buffer) => void): void { this.sink = sink; if (this.buffer.length) sink(this.buffer); this.buffer = Buffer.alloc(0) }
}

function rawBuffer(data: RawData): Buffer { return Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer) }

/** A stale or hung entitlement provider must never extend viewer authority. */
function boundedAuthorization(check: () => Promise<boolean>): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Desktop authorization timeout')), 2000)
    Promise.resolve().then(check).then(result => { clearTimeout(timer); resolve(result) }, error => { clearTimeout(timer); reject(error) })
  })
}
