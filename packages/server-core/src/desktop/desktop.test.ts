import { describe, test, expect } from 'bun:test'
import { createServer as tcpServer } from 'node:net'
import { createServer } from 'node:http'
import { PassThrough } from 'node:stream'
import { WsRpcServer } from '../transport/server'
import { PROTOCOL_VERSION } from '@craft-agent/shared/protocol'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { WatchServerGate } from './rfb-server'
import { WatchRfbGate } from './rfb-watch'
import { DesktopGateway } from './gateway'
// @ts-expect-error upstream has no declarations
import { DESECBCipher } from '@novnc/novnc/lib/crypto/des.js'

const version = Buffer.from('RFB 003.008\n')
const normalGate = () => { const gate = new WatchRfbGate(); gate.push(Buffer.concat([version, Buffer.from([1, 1])])); return gate }
describe('read-only RFB boundary', () => {
  test('fragmented and coalesced handshake; shared only', () => {
    const gate = new WatchRfbGate()
    expect(gate.push(version.subarray(0, 5))).toEqual([])
    expect(gate.push(Buffer.concat([version.subarray(5), Buffer.from([1, 1])])).length).toBe(3)
    expect(() => new WatchRfbGate().push(Buffer.concat([version, Buffer.from([1, 0])]))).toThrow()
  })
  test('input, clipboard, file transfer and unknown extensions fail closed', () => {
    for (const type of [1, 4, 5, 6, 7, 150, 248, 251, 255]) {
      const gate = normalGate()
      expect(() => gate.push(Buffer.from([type]))).toThrow()
      expect(() => gate.push(Buffer.from([3]))).toThrow()
    }
  })
  test('encoding list is bounded and rewritten to Raw only', () => {
    const gate = normalGate()
    expect(gate.push(Buffer.from([2, 0, 0, 2, 0, 0]))).toEqual([])
    expect(gate.push(Buffer.from([0, 7, 255, 255, 255, 33]))).toEqual([Buffer.from([2, 0, 0, 1, 0, 0, 0, 0])])
    expect(() => gate.push(Buffer.from([2, 0, 0, 65]))).toThrow()
  })
  test('actual noVNC RGB byte ordering accepted; exotic format denied', () => {
    const packet = Buffer.from([0,0,0,0,32,24,0,1,0,255,0,255,0,255,0,8,16,0,0,0])
    expect(normalGate().push(packet)).toEqual([packet])
    packet[4] = 16
    expect(() => normalGate().push(packet)).toThrow()
  })
  test('server clipboard is stripped across fragmented/coalesced packets', () => {
    const gate = new WatchServerGate()
    expect(gate.push(Buffer.from([3,0,0,0,0,0]))).toEqual([])
    expect(gate.push(Buffer.from([0,3,65,66,67,2]))).toEqual([Buffer.from([2])])
    expect(() => gate.push(Buffer.from([99]))).toThrow()
  })
  test('oversize and unsupported version fail closed', () => {
    expect(() => new WatchRfbGate().push(Buffer.alloc(65537))).toThrow()
    expect(() => new WatchRfbGate().push(Buffer.from('RFB 003.003\n'))).toThrow()
  })
})

const scope = { workspaceId: 'workspace-a', sessionId: 'session-a' }
const origin = 'https://desktop.example.test'
function options() { return { origin, upstream: { host: '127.0.0.1', port: 5902, password: async () => 'fixture' }, authorize: async (headers: Headers, s: typeof scope) => headers.get('cookie') === 'fixture=authorized' && s.workspaceId === scope.workspaceId && s.sessionId === scope.sessionId } }
async function grant(gateway: DesktopGateway, overrides: Record<string, string> = {}, requestScope = scope) {
  return gateway.fetch(new Request(`${origin}/api/desktop/grant`, { method: 'POST', headers: { origin, cookie: 'fixture=authorized', ...overrides }, body: JSON.stringify(requestScope) }))
}

describe('gateway authorization', () => {
  test('rejects public, DNS, plaintext and noncanonical origins', () => {
    for (const host of ['8.8.8.8', 'localhost', '169.254.169.254', '192.168.1.1']) expect(() => new DesktopGateway({ ...options(), upstream: { ...options().upstream, host } })).toThrow()
    for (const bad of ['http://desktop.example.test', `${origin}/`]) expect(() => new DesktopGateway({ ...options(), origin: bad })).toThrow()
  })
  test('login alone is not scope entitlement; origin and body bounds', async () => {
    const gateway = new DesktopGateway(options())
    try {
      expect((await grant(gateway, { origin: 'https://evil.test' })).status).toBe(503)
      expect((await grant(gateway, { cookie: '' })).status).toBe(503)
      expect((await grant(gateway, {}, { ...scope, sessionId: 'foreign' })).status).toBe(503)
      expect((await grant(gateway)).status).toBe(200)
      expect((await gateway.fetch(new Request(`${origin}/api/desktop/grant`, { method: 'POST', headers: { origin }, body: 'x'.repeat(1025) }))).status).toBe(503)
    } finally { gateway.dispose() }
  })
  test('RPC grants require explicit entitlement and connected scope', async () => {
    const gateway = new DesktopGateway({ ...options(), electronOrigin: 'null', authorizeRpc: async (_, s) => s.sessionId === scope.sessionId })
    const ctx = { workspaceId: scope.workspaceId, clientId: 'client', webContentsId: null }
    try {
      await expect(gateway.issueRpcGrant(ctx, scope.sessionId, 'null', () => false)).rejects.toThrow()
      await expect(gateway.issueRpcGrant(ctx, 'foreign', 'null', () => true)).rejects.toThrow()
      expect((await gateway.issueRpcGrant(ctx, scope.sessionId, 'null', () => true)).url).toBe('wss://desktop.example.test/api/desktop/view')
    } finally { gateway.dispose() }
  })
})

/** Isolated loopback-only fixture. Never contacts the user's desktop. */
test('end-to-end VNC auth, shared init, framebuffer, replay denial and server input enforcement', async () => {
  const seen: Buffer[] = []
  let connections = 0
  const sockets = new Set<import('node:net').Socket>()
  const upstream = tcpServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); connections++
    socket.write(version.subarray(0, 4)); socket.write(version.subarray(4))
    let state = 0
    const challenge = Buffer.from('0123456789abcdef')
    socket.on('data', data => {
      if (state === 0) { expect(data.equals(version)).toBe(true); socket.write(Buffer.from([1, 2])); state++ }
      else if (state === 1) { expect(data[0]).toBe(2); socket.write(challenge); state++ }
      else if (state === 2) {
        const key = new Uint8Array(8); key.set(Buffer.from('fixture'))
        const expected = Buffer.from(DESECBCipher.importKey(key).encrypt({}, challenge))
        expect(data.equals(expected)).toBe(true); socket.write(Buffer.alloc(4)); state++
      } else if (state === 3) {
        expect(data).toEqual(Buffer.from([1]))
        const init = Buffer.alloc(24); init.writeUInt16BE(2, 0); init.writeUInt16BE(2, 2)
        init.set([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0], 4)
        socket.write(init); state++
      } else {
        seen.push(Buffer.from(data))
        if (data[0] === 3) { const frame = Buffer.alloc(32); frame[3] = 1; frame.writeUInt16BE(2, 8); frame.writeUInt16BE(2, 10); frame.fill(127, 16); socket.write(frame) }
      }
    })
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const port = (upstream.address() as { port: number }).port
  let authorization: 'allow' | 'deny' | 'hang' = 'allow'
  const gateway = new DesktopGateway({ ...options(), authorize: async (headers, requested) => authorization === 'hang' ? new Promise<boolean>(() => {}) : authorization === 'allow' && options().authorize(headers, requested), upstream: { ...options().upstream, port }, trustedTlsIngress: true })
  const http = createServer(); http.on('upgrade', (req, socket, head) => gateway.upgrade(req, socket, head))
  http.listen(0, '127.0.0.1'); await once(http, 'listening')
  const url = `ws://127.0.0.1:${(http.address() as { port: number }).port}/api/desktop/view`
  let ws: WebSocket | undefined
  try {
    const { token } = await (await grant(gateway)).json() as { token: string }
    ws = new WebSocket(url, { headers: { Origin: origin } })
    ws.on('error', error => console.error('fixture websocket:', error.message))
    const messages: Buffer[] = []; const waiters: (() => void)[] = []
    ws.on('message', data => { messages.push(Buffer.from(data as Buffer)); waiters.shift()?.() })
    const next = async () => { if (!messages.length) await new Promise<void>(resolve => waiters.push(resolve)); return messages.shift()! }
    await once(ws, 'open'); ws.send(JSON.stringify({ token }))
    expect(JSON.parse((await next()).toString())).toEqual({ ready: true })
    expect(await next()).toEqual(version)
    ws.send(version); expect(await next()).toEqual(Buffer.from([1, 1]))
    ws.send(Buffer.from([1])); expect(await next()).toEqual(Buffer.alloc(4))
    ws.send(Buffer.from([1])); expect((await next()).readUInt16BE(0)).toBe(2)
    ws.send(Buffer.from([3, 0, 0, 0, 0, 0, 0, 2, 0, 2])); expect((await next()).length).toBe(32)
    const closed = once(ws, 'close'); ws.send(Buffer.from([4, 1, 0, 0, 0, 0, 0, 65])); await closed
    expect(seen.flatMap(b => [...b]).includes(65)).toBe(false)
    const replay = new WebSocket(url, { headers: { Origin: origin } }); replay.on('error', () => {}); await once(replay, 'open')
    const rejected = once(replay, 'close'); replay.send(JSON.stringify({ token })); await rejected
    expect(connections).toBe(1)
    // Expired grant never opens upstream. Simulate issuance in the past, not a long sleep.
    const realNow = Date.now
    let expired: string
    try { Date.now = () => realNow() - 31_000; expired = (await (await grant(gateway)).json() as { token: string }).token }
    finally { Date.now = realNow }
    const deniedSocket = async (token: string) => {
      const client = new WebSocket(url, { headers: { Origin: origin } }); client.on('error', () => {})
      await once(client, 'open'); const done = once(client, 'close'); client.send(JSON.stringify({ token })); await done
    }
    await deniedSocket(expired!)
    expect(connections).toBe(1)
    // Hung initial validation closes promptly; no upstream connection.
    const initial = (await (await grant(gateway)).json() as { token: string }).token
    authorization = 'hang'
    await deniedSocket(initial)
    expect(connections).toBe(1)
    authorization = 'allow'
    // Active explicit revoke, revoked entitlement, and hung revalidation all terminate.
    for (const mode of ['revoke', 'deny', 'hang'] as const) {
      const activeToken = (await (await grant(gateway)).json() as { token: string }).token
      const active = new WebSocket(url, { headers: { Origin: origin } }); active.on('error', () => {})
      await once(active, 'open')
      const ready = once(active, 'message'); active.send(JSON.stringify({ token: activeToken })); await ready
      const done = once(active, 'close')
      if (mode === 'revoke') gateway.revoke(scope)
      else authorization = mode
      await done
      authorization = 'allow'
    }
    expect(connections).toBe(4)
  } finally {
    ws?.terminate(); gateway.dispose(); for (const socket of sockets) socket.destroy()
    http.closeAllConnections(); http.close(); upstream.close()
  }
}, 20_000)

test('upgrade rejects insecure transport, foreign/missing Origin and query tokens before upstream', () => {
  const gateway = new DesktopGateway(options())
  try {
    for (const [secure, requestOrigin, path] of [[false, origin, '/api/desktop/view'], [true, 'https://evil.test', '/api/desktop/view'], [true, undefined, '/api/desktop/view'], [true, origin, '/api/desktop/view?token=forbidden']] as const) {
      const socket = new PassThrough()
      let response = ''
      socket.on('data', chunk => { response += chunk.toString() })
      gateway.upgrade({ url: path, headers: { origin: requestOrigin }, socket: { encrypted: secure } } as any, socket, Buffer.alloc(0))
      expect(response).toContain('503 Service Unavailable')
    }
  } finally { gateway.dispose() }
})

test('authenticated RPC bridge binds grant to connected workspace; disconnect revokes it', async () => {
  const gateway = new DesktopGateway({ ...options(), trustedTlsIngress: true, authorizeRpc: async (ctx, s) => ctx.workspaceId === scope.workspaceId && s.sessionId === scope.sessionId })
  const server = new WsRpcServer({ desktopGateway: gateway, requireAuth: true, validateToken: async token => token === 'fixture-token', host: '127.0.0.1', port: 0 })
  await server.listen()
  const client = new WebSocket(`ws://127.0.0.1:${server.port}`)
  client.on('error', () => {})
  try {
    await once(client, 'open')
    const ack = once(client, 'message')
    client.send(JSON.stringify({ id: 'h', type: 'handshake', protocolVersion: PROTOCOL_VERSION, token: 'fixture-token', workspaceId: scope.workspaceId }))
    expect(JSON.parse((await ack)[0].toString()).type).toBe('handshake_ack')
    const result = once(client, 'message')
    client.send(JSON.stringify({ id: 'g', type: 'request', channel: 'desktop:grant', args: [scope.sessionId, origin] }))
    const reply = JSON.parse((await result)[0].toString())
    expect(reply.error).toBeUndefined()
    expect(typeof reply.result.token).toBe('string')
    const denied = once(client, 'message')
    client.send(JSON.stringify({ id: 'd', type: 'request', channel: 'desktop:grant', args: ['foreign', origin] }))
    expect(JSON.parse((await denied)[0].toString()).error).toBeDefined()
    const closed = once(client, 'close'); client.close(); await closed
    const viewer = new WebSocket(`ws://127.0.0.1:${server.port}/api/desktop/view`, { headers: { Origin: origin } })
    viewer.on('error', () => {})
    await once(viewer, 'open'); const rejected = once(viewer, 'close')
    viewer.send(JSON.stringify({ token: reply.result.token })); await rejected
  } finally { client.terminate(); server.close() }
}, 10_000)
