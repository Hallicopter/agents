import { connect, type Socket } from 'node:net'
import type { RawData, WebSocket } from 'ws'
// @ts-expect-error noVNC does not ship declarations
import { DESECBCipher } from '@novnc/novnc/lib/crypto/des.js'
import type { DesktopControlOptions, DesktopGatewayOptions, DesktopScope } from './gateway'
import { ControlRfbGate, RfbInputState } from './rfb-input'
import { ControlServerGate, RfbFenceBarrier, controlEncodings } from './rfb-fence'

interface ControlGrant {
  scope: DesktopScope
  validate: () => Promise<boolean>
  control: { connectionId: string; connected: () => boolean }
}
const version = Buffer.from('RFB 003.008\n')
const pixelFormat = Buffer.from([0,0,0,0,32,24,0,1,0,255,0,255,0,255,0,8,16,0,0,0])

/** Trusted, explicitly enabled broker path ONLY. Raw/direct VNC is not covered.
 * The host must interpose every competing mutator through the same arbiter.
 * Fence alone is insufficient for pointer drain on Xtigervnc: the mandatory host
 * callback asserts actual input-drain completion, not a query/empty write/XSync
 * on an unrelated display. This module never implements or defaults that proof.
 */
export function controlStream(ws: WebSocket, grant: ControlGrant, endpoint: DesktopGatewayOptions['upstream'], options: DesktopControlOptions): void {
  const { arbiter } = options
  const deadline = Math.min(options.entitlementExpiresAt(grant.scope), Date.now() + 300_000)
  if (!Number.isSafeInteger(deadline) || deadline <= Date.now() || !grant.control.connected()) throw new Error('Control unavailable')
  let lease: ReturnType<typeof arbiter.acquireHuman>
  try { lease = arbiter.acquireHuman({ ...grant.scope, connectionId: grant.control.connectionId }, deadline) }
  catch (error) { console.warn('[desktop-control] admission denied; phase=' + arbiter.state.phase); throw error }
  const upstream = connect(endpoint.port, endpoint.host)
  const reader = new ControlReader(upstream)
  const gate = new ControlRfbGate()
  const state = new RfbInputState()
  let closing = false
  let settled = false
  let accepted = false
  let ready = false
  let frontendInitialized = false
  let step = 0
  let early = Buffer.alloc(0)
  let alive = true
  let checking = false
  let expiresAt = 0

  // Every upstream write is synchronous and queue-bounded. No delayed input
  // callback is retained; an ambiguous write poisons ownership, never frees it.
  const write = (message: Buffer) => {
    if (upstream.destroyed || !upstream.writable || upstream.writableLength + message.length > 65536) throw new Error('Desktop write unavailable')
    upstream.write(message, error => { if (error) lost() })
  }
  const barrier = new RfbFenceBarrier(write)
  const serverGate = new ControlServerGate(message => barrier.receive(message))
  const quarantine = () => { try { arbiter.quarantine() } catch { /* already fail closed */ } }
  const finish = () => {
    settled = true
    barrier.fail()
    upstream.destroy()
    if (ws.readyState === 1) ws.close(1000, 'Desktop control ended')
  }
  const close = () => {
    if (closing) return
    // Fence the lease BEFORE any await, even when the WS is already gone.
    closing = true
    clearTimeout(handshake); clearTimeout(lifetime); clearInterval(revalidation); clearInterval(heartbeat)
    try { arbiter.beginRelease(lease) } catch { quarantine(); finish(); return }
    let releaseStage = 'release-events'
    void (async () => {
      if (accepted) {
        // Never destroy a still-live upstream on WS loss before attempting this.
        for (const message of state.releases()) write(message)
        releaseStage = 'fence'
        await barrier.wait(2000)
        releaseStage = 'host-drain'
        await hostProof(() => options.confirmInputDrained(grant.scope))
        state.confirmReleased()
      }
      releaseStage = 'arbiter'
      arbiter.finishRelease(lease, true)
    })().catch(() => { console.warn('[desktop-control] release proof failed at ' + releaseStage); quarantine() }).finally(finish)
  }
  function lost(): void {
    if (settled) return
    // A socket loss after ANY accepted input is ambiguous even if no keys are held.
    if (accepted) { console.warn('[desktop-control] upstream lost after input'); quarantine() }
    barrier.fail()
    close()
  }
  const send = (message: Buffer) => {
    if (closing) return
    if (ws.readyState !== 1 || ws.bufferedAmount + message.length > 16 * 1024 * 1024) { close(); return }
    ws.send(message, { binary: true }, error => { if (error) close() })
  }
  const handshake = setTimeout(close, 10_000)
  let lifetime: ReturnType<typeof setTimeout> | undefined
  const revalidation = setInterval(async () => {
    if (closing || checking) return
    checking = true
    try { if (!arbiter.valid(lease) || !await grant.validate()) close() } catch { close() }
    finally { checking = false }
  }, 1000)
  const heartbeat = setInterval(() => {
    if (!alive || ws.readyState !== 1) { close(); return }
    alive = false
    ws.ping(undefined, undefined, error => { if (error) close() })
  }, 15_000)
  ws.on('pong', () => { alive = true })
  ws.once('close', close)
  ws.on('error', close)
  upstream.on('error', lost)
  upstream.once('close', lost)

  ws.on('message', (raw: RawData, binary: boolean) => {
    if (closing) return // discard all unsent/stale input, including queued WS events
    try {
      if (!binary) {
        const text = rawBuffer(raw)
        if (text.length > 128 || JSON.parse(text.toString()).type !== 'return-control') throw new Error('Invalid control command')
        close(); return
      }
      const data = rawBuffer(raw)
      if (!ready || data.length > 65536) throw new Error('Control not ready')
      // There is no asynchronous parser/write chain. The final arbiter check and
      // the actual socket.write share one synchronous writeHuman invocation.
      for (const message of gate.push(data)) {
        if (closing) break
        if (step === 0) { send(Buffer.from([1, 1])); step++ }
        else if (step === 1) { send(Buffer.alloc(4)); step++ }
        else if (step === 2) {
          if (early.length) throw new Error('Incomplete early server packet')
          send(serverInit!)
          frontendInitialized = true; step++
          clearTimeout(handshake)
        } else if (message[0] === 4 || message[0] === 5) {
          if (!grant.control.connected()) throw new Error('RPC disconnected')
          arbiter.writeHuman(lease, () => {
            state.record(message)
            // Set before write: an exception or asynchronous socket failure is ambiguous.
            accepted = true
            write(message)
          }) // callback MUST return undefined, not socket.write's boolean
        } else {
          if (!arbiter.valid(lease) || !grant.control.connected()) throw new Error('Lease revoked')
          write(message[0] === 2 ? controlEncodings() : message)
        }
      }
    } catch (error) { console.warn("[desktop-control] client parser: " + (error instanceof Error ? error.message : "invalid")); close() }
  })

  let serverInit: Buffer | undefined
  const serverData = (data: Buffer) => {
    try {
      if (frontendInitialized) {
        for (const packet of serverGate.push(data)) send(packet)
        return
      }
      // Before frontend ClientInit, allow only internal Fence and harmless Bell.
      // Reject a framebuffer at its FIRST byte, even if fragmented across init.
      if (early.length + data.length > 65536) throw new Error('Early server limit')
      early = Buffer.concat([early, data])
      while (early.length) {
        if (early[0] === 2) { early = early.subarray(1); continue }
        if (early[0] !== 248) throw new Error('Unexpected early server message')
        if (early.length < 9) return
        const size = 9 + early[8]!
        if (size > 73) throw new Error('Fence payload limit')
        if (early.length < size) return
        serverGate.push(early.subarray(0, size)); early = early.subarray(size)
      }
    } catch (error) { console.warn("[desktop-control] server parser: " + (error instanceof Error ? error.message : "invalid")); if (accepted) quarantine(); barrier.fail(); close() }
  }
  void (async () => {
    expiresAt = arbiter.state.humanExpiresAt!
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) throw new Error('Invalid lease expiry')
    lifetime = setTimeout(close, expiresAt - Date.now())
    if ((await reader.read(12)).toString() !== version.toString() || closing) throw new Error('RFB version')
    write(version)
    const count = (await reader.read(1))[0]!
    if (!count || count > 32 || !(await reader.read(count)).includes(2) || closing) throw new Error('RFB authentication')
    write(Buffer.from([2]))
    const challenge = await reader.read(16)
    const password = await endpoint.password()
    if (!password || password.length > 8 || /[^\x20-\x7e]/.test(password) || closing) throw new Error('RFB credential')
    const key = new Uint8Array(8); key.set(Buffer.from(password, 'ascii'))
    try { write(Buffer.from(DESECBCipher.importKey(key).encrypt({}, challenge))) } finally { key.fill(0) }
    if ((await reader.read(4)).readUInt32BE(0) !== 0 || closing) throw new Error('RFB authentication')
    write(Buffer.from([1])) // shared upstream ClientInit, before gateway readiness
    const init = await reader.read(24)
    const nameSize = init.readUInt32BE(20)
    if (nameSize > 4096) throw new Error('Desktop title limit')
    await reader.read(nameSize)
    if (closing) throw new Error('Control closed')
    gate.setFramebufferSize(init.readUInt16BE(0), init.readUInt16BE(2))
    const name = Buffer.from('Private desktop — control')
    pixelFormat.copy(init, 4, 4, 20); init.writeUInt32BE(name.length, 20)
    serverInit = Buffer.concat([init, name]) // held for the fake frontend handshake
    reader.pipe(serverData)
    if (closing) throw new Error('Control closed')
    write(pixelFormat); write(controlEncodings())
    await barrier.wait(2000) // unpredictable BlockBefore probe, not mere support advertising
    if (closing || !await grant.validate() || !arbiter.valid(lease) || ws.readyState !== 1) throw new Error('Control unavailable')
    if (closing || !grant.control.connected()) throw new Error('Control unavailable')
    ready = true
    ws.send(JSON.stringify({ ready: true, mode: 'control', controlExpiresAt: expiresAt, controlDurationMs: Math.max(0, expiresAt - Date.now()) }))
    send(version)
  })().catch(close)
}

function rawBuffer(data: RawData): Buffer { return Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer) }

function hostProof(check: () => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Host input drain timeout')), 8000)
    Promise.resolve().then(check).then(result => {
      clearTimeout(timer)
      if (result !== undefined) reject(new Error('Invalid host drain proof'))
      else resolve()
    }, error => { clearTimeout(timer); reject(error) })
  })
}

/** Control-private reader: deliberately leaves watch's exact handshake unchanged. */
class ControlReader {
  private buffer = Buffer.alloc(0)
  private waiter: (() => void) | undefined
  private closed = false
  private sink: ((data: Buffer) => void) | undefined
  constructor(socket: Socket) {
    socket.on('data', data => {
      if (!Buffer.isBuffer(data)) { socket.destroy(); return }
      if (this.sink) { this.sink(data); return }
      if (this.buffer.length + data.length > 65536) { socket.destroy(); return }
      this.buffer = Buffer.concat([this.buffer, data]); this.waiter?.()
    })
    const closed = () => { this.closed = true; this.waiter?.() }
    socket.on('close', closed); socket.on('error', closed)
  }
  async read(size: number): Promise<Buffer> {
    while (this.buffer.length < size) {
      if (this.closed) throw new Error('Desktop disconnected')
      await new Promise<void>(resolve => { this.waiter = resolve }); this.waiter = undefined
    }
    const result = Buffer.from(this.buffer.subarray(0, size)); this.buffer = this.buffer.subarray(size); return result
  }
  pipe(sink: (data: Buffer) => void): void {
    this.sink = sink
    const data = this.buffer; this.buffer = Buffer.alloc(0)
    if (data.length) sink(data)
  }
}
