import { test, expect } from 'bun:test'
import { createServer as tcpServer, type Socket } from 'node:net'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { DesktopGateway } from './gateway'
import { InputArbiter } from './input-arbiter'

for (const proof of [true, false]) test(`control disconnect releases held input; host proof=${proof}`, async () => {
  const seen: Buffer[] = []; const sockets = new Set<Socket>()
  const upstream = tcpServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket))
    socket.write('RFB 003.008\n')
    let step = 0; let pending = Buffer.alloc(0)
    socket.on('data', data => {
      pending = Buffer.concat([pending, data])
      while (pending.length) {
        let size = 0
        if (step === 0) size = 12
        else if (step === 1) size = 1
        else if (step === 2) size = 16
        else if (step === 3) size = 1
        else if (pending[0] === 0) size = 20
        else if (pending[0] === 2) { if (pending.length < 4) return; size = 4 + pending.readUInt16BE(2) * 4 }
        else if (pending[0] === 248) { if (pending.length < 9) return; size = 9 + pending[8]! }
        else if (pending[0] === 4) size = 8
        else if (pending[0] === 5) size = 6
        else throw new Error('Unexpected fixture input')
        if (pending.length < size) return
        const packet = Buffer.from(pending.subarray(0, size)); pending = pending.subarray(size)
        if (step === 0) { socket.write(Buffer.from([1, 2])); step++ }
        else if (step === 1) { socket.write(Buffer.alloc(16)); step++ }
        else if (step === 2) { socket.write(Buffer.alloc(4)); step++ }
        else if (step === 3) {
          const init = Buffer.alloc(24); init.writeUInt16BE(20, 0); init.writeUInt16BE(20, 2); socket.write(init); step++
        } else if (packet[0] === 248) { packet.writeUInt32BE(1, 4); socket.write(packet) }
        else if (packet[0] === 4 || packet[0] === 5) seen.push(packet)
      }
    })
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const arbiter = new InputArbiter({ initialJournal: { version: 1, dirty: false }, persistJournal: () => {}, cooperativeOwnerPresent: () => false, legacyProxyActive: () => false, authorizeHuman: () => true })
  let proved = false
  const origin = 'https://fixture.test'
  const gateway = new DesktopGateway({ origin, trustedTlsIngress: true, upstream: { host: '127.0.0.1', port: (upstream.address() as any).port, password: async () => 'fixture' }, authorize: async () => false, authorizeRpc: async () => true,
    control: { arbiter, authorizeRpc: async () => true, entitlementExpiresAt: () => Date.now() + 60000, confirmInputDrained: async () => { proved = true; if (!proof) throw new Error('unconfirmed') } } })
  const server = createServer(); server.on('upgrade', (req, socket, head) => gateway.upgrade(req, socket, head))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  let ws: WebSocket | undefined
  try {
    const grant = await gateway.issueRpcGrant({ workspaceId: 'ws', clientId: 'client', webContentsId: null }, 'session', origin, () => true, 'control')
    ws = new WebSocket(`ws://127.0.0.1:${(server.address() as any).port}/api/desktop/view`, { headers: { Origin: origin } })
    let step = 0
    const initialized = new Promise<void>(resolve => {
      ws!.on('message', (data, binary) => {
        if (!binary) return
        if (step === 0) { ws!.send(Buffer.from('RFB 003.008\n')); step++ }
        else if (step === 1) { ws!.send(Buffer.from([1])); step++ }
        else if (step === 2) { ws!.send(Buffer.from([1])); step++ }
        else if (step === 3) { step++; resolve() }
      })
    })
    await once(ws, 'open'); ws.send(JSON.stringify({ token: grant.token })); await initialized
    expect(arbiter.state.phase).toBe('human')
    expect(() => arbiter.beginAgent('blocked')).toThrow()
    ws.send(Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]))
    for (let i = 0; i < 100 && !seen.length; i++) await new Promise(r => setTimeout(r, 10))
    expect(seen).toHaveLength(1)
    ws.close()
    for (let i = 0; i < 200 && ['human', 'releasing'].includes(arbiter.state.phase); i++) await new Promise(r => setTimeout(r, 10))
    expect(seen.some(packet => packet[0] === 4 && packet[1] === 0)).toBe(true)
    expect(proved).toBe(true)
    expect(arbiter.state.phase).toBe(proof ? 'idle' : 'quarantine')
  } finally {
    ws?.terminate(); gateway.dispose(); for (const socket of sockets) socket.destroy()
    await Promise.all([new Promise<void>(r => server.close(() => r())), new Promise<void>(r => upstream.close(() => r()))])
  }
}, 10000)
