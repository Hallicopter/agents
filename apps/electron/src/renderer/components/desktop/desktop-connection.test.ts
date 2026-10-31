import { describe, expect, it } from 'bun:test'
import { connectDesktop, type DesktopGrant, type DesktopMode, type DesktopRfb, type DesktopState } from './desktop-connection'

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const endpoint = 'wss://desktop.example/api/desktop/view'
const controlReady = () => ({ ready: true, mode: 'control', controlExpiresAt: Date.now() + 60_000 })
class Socket extends EventTarget {
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  sent: string[] = []
  closed = false
  send(data: string) { this.sent.push(data) }
  close() { this.closed = true }
  ready(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }) }
}
class Rfb implements DesktopRfb {
  viewOnly = false
  scaleViewport = false
  resizeSession = true
  showDotCursor = true
  focusOnClick = true
  disconnected = false
  blurred = false
  listeners = new Map<string, () => void>()
  disconnect() { this.disconnected = true }
  blur() { this.blurred = true }
  addEventListener(name: string, cb: () => void) { this.listeners.set(name, cb) }
  emit(name: string) { this.listeners.get(name)?.() }
}
function harness(mode: DesktopMode = 'watch', grant?: () => Promise<DesktopGrant>, timeoutMs = 1000) {
  const socket = new Socket()
  const rfb = new Rfb()
  const states: DesktopState[] = []
  let grants = 0, sockets = 0, viewers = 0
  const stop = connectDesktop({
    mode, timeoutMs,
    grant: async () => { grants++; return grant ? grant() : { token: 'private-token', url: endpoint, mode } },
    loadRfb: async () => () => { viewers++; return rfb },
    socket: () => { sockets++; return socket as unknown as WebSocket },
    onState: state => states.push(state),
  })
  return { stop, socket, rfb, states, counts: () => ({ grants, sockets, viewers }) }
}

describe('Desktop explicit connection lifecycle', () => {
  it('preserves legacy ready:true watch with scaled viewport and no input/resize', async () => {
    const h = harness('watch', async () => ({ token: 'private-token', url: endpoint }))
    await tick()
    h.socket.onopen?.()
    expect(h.socket.sent).toEqual(['{"token":"private-token"}'])
    h.socket.ready({ ready: true })
    expect(h.rfb.viewOnly).toBe(true)
    h.rfb.emit('connect')
    expect(h.states.at(-1)?.phase).toBe('watch')
    expect(h.rfb.viewOnly).toBe(true)
    expect(h.rfb.scaleViewport).toBe(true)
    expect(h.rfb.resizeSession).toBe(false)
    expect(h.rfb.focusOnClick).toBe(false)
    h.stop()
  })
  for (const available of [undefined, false, true, 'true', 1]) {
    it(`advertises Control only for explicit boolean true, not ${String(available)}`, async () => {
      const h = harness('watch', async () => ({ token: 'private-token', url: endpoint, controlAvailable: available }) as DesktopGrant)
      await tick()
      h.socket.ready({ ready: true })
      expect(h.states.at(-1)?.controlAvailable).toBe(false)
      h.rfb.emit('connect')
      expect(h.states.at(-1)?.phase).toBe('watch')
      expect(h.states.at(-1)?.controlAvailable).toBe(available === true)
      expect(h.rfb.viewOnly).toBe(true) // capability is never input authorization
      h.stop()
    })
  }
  it('does not publish stale capability from a disposed grant or ready event', async () => {
    let resolve!: (grant: DesktopGrant) => void
    const pending = new Promise<DesktopGrant>(r => { resolve = r })
    const old = harness('watch', () => pending)
    await tick()
    old.stop()
    resolve({ token: 'late-token', url: endpoint, controlAvailable: true })
    await tick()
    expect(old.states).toHaveLength(1)
    expect(old.states.some(state => state.controlAvailable === true)).toBe(false)
    const watching = harness('watch', async () => ({ token: 'private-token', url: endpoint, controlAvailable: true }))
    await tick()
    watching.socket.ready({ ready: true })
    watching.stop()
    watching.rfb.emit('connect')
    expect(watching.states.some(state => state.controlAvailable === true)).toBe(false)
    const fresh = harness('watch')
    await tick()
    fresh.socket.ready({ ready: true })
    fresh.rfb.emit('connect')
    expect(fresh.states.at(-1)?.controlAvailable).toBe(false)
    fresh.stop()
  })
  it('does not enable input from a grant alone; requires ready control and RFB connect', async () => {
    const h = harness('control')
    await tick()
    expect(h.states.at(-1)?.phase).toBe('requesting')
    h.socket.ready(controlReady())
    expect(h.rfb.viewOnly).toBe(true)
    expect(h.states.at(-1)?.phase).toBe('connecting')
    h.rfb.emit('connect')
    expect(h.rfb.viewOnly).toBe(false)
    expect(h.states.at(-1)?.controlExpiresAt).toBeGreaterThan(Date.now())
    expect(h.rfb.focusOnClick).toBe(true)
    expect(h.states.at(-1)?.phase).toBe('control')
    h.stop()
    expect(h.rfb.viewOnly).toBe(true)
    expect(h.rfb.disconnected).toBe(true)
  })
  for (const mode of [undefined, 'watch', 'unknown']) {
    it(`rejects control grant mode ${String(mode)} before opening a socket`, async () => {
      const h = harness('control', async () => ({ token: 'private-token', url: endpoint, mode }) as DesktopGrant)
      await tick()
      expect(h.counts().sockets).toBe(0)
      expect(h.states.at(-1)?.phase).toBe('error')
      h.stop()
    })
  }
  for (const expiry of [undefined, null, 'later', Infinity, NaN, -1, Date.now() + 10 * 60_000]) {
    it(`rejects invalid or unbounded control expiry ${String(expiry)}`, async () => {
      const h = harness('control')
      await tick()
      h.socket.ready({ ready: true, mode: 'control', controlExpiresAt: expiry })
      expect(h.counts().viewers).toBe(0)
      expect(h.states.at(-1)?.phase).toBe('error')
      h.stop()
    })
  }
  for (const ready of [{ ready: true }, { ready: true, mode: 'watch' }, { ready: false }]) {
    it(`fails closed for a control request receiving ${JSON.stringify(ready)}`, async () => {
      const h = harness('control')
      await tick()
      h.socket.ready(ready)
      expect(h.counts().viewers).toBe(0)
      expect(h.socket.closed).toBe(true)
      expect(h.states.at(-1)?.phase).toBe('error')
      expect(h.states.at(-1)?.message).toContain('Control unavailable')
      h.stop()
    })
  }
  it('does not upgrade an explicit watch request even if socket advertises control', async () => {
    const h = harness()
    await tick()
    h.socket.ready(controlReady())
    h.rfb.emit('connect')
    expect(h.rfb.viewOnly).toBe(true)
    expect(h.states.at(-1)?.phase).toBe('watch')
    h.stop()
  })
  it('ignores a late grant after Return/close; creates no socket', async () => {
    let resolve!: (grant: DesktopGrant) => void
    const pending = new Promise<DesktopGrant>(r => { resolve = r })
    const h = harness('control', () => pending)
    await tick()
    h.stop()
    resolve({ token: 'late-token', url: endpoint, mode: 'control' })
    await tick()
    expect(h.counts().sockets).toBe(0)
    expect(h.states).toHaveLength(1)
  })
  it('ignores stale ready and RFB connect events after a mode switch', async () => {
    const old = harness('control')
    await tick()
    old.socket.ready(controlReady())
    old.stop()
    const watching = harness()
    await tick()
    old.socket.ready(controlReady())
    old.rfb.emit('connect')
    watching.socket.ready({ ready: true })
    watching.rfb.emit('connect')
    expect(old.rfb.viewOnly).toBe(true)
    expect(old.states.at(-1)?.phase).not.toBe('control')
    expect(watching.states.at(-1)?.phase).toBe('watch')
    watching.stop()
  })
  it('revokes input immediately on socket close and never retries Control', async () => {
    const h = harness('control')
    await tick()
    h.socket.ready(controlReady())
    h.rfb.emit('connect')
    h.socket.dispatchEvent(new Event('close'))
    await tick()
    expect(h.rfb.viewOnly).toBe(true)
    expect(h.states.at(-1)?.phase).toBe('disconnected')
    expect(h.counts()).toEqual({ grants: 1, sockets: 1, viewers: 1 })
    h.stop()
  })
  it('invalidates pending grants on timeout; no late reconnection', async () => {
    let resolve!: (grant: DesktopGrant) => void
    const pending = new Promise<DesktopGrant>(r => { resolve = r })
    const h = harness('control', () => pending, 5)
    await new Promise(r => setTimeout(r, 15))
    expect(h.states.at(-1)?.phase).toBe('error')
    resolve({ token: 'late-token', url: endpoint, mode: 'control' })
    await tick()
    expect(h.counts().sockets).toBe(0)
    h.stop()
  })
  it('ends confirmed control at server expiry without reconnecting', async () => {
    const h = harness('control')
    await tick()
    h.socket.ready({ ready: true, mode: 'control', controlExpiresAt: Date.now() + 5 })
    h.rfb.emit('connect')
    await new Promise(r => setTimeout(r, 15))
    expect(h.rfb.viewOnly).toBe(true)
    expect(h.states.at(-1)?.phase).toBe('disconnected')
    expect(h.counts().grants).toBe(1)
    h.stop()
  })
  it('sanitizes backend busy/errors rather than leaking grants or raw errors', async () => {
    const h = harness('control', async () => { throw new Error('secret-token upstream-host') })
    await tick()
    expect(h.states.at(-1)?.message).toContain('desktop is busy or control is not enabled')
    expect(JSON.stringify(h.states)).not.toContain('secret-token')
    h.stop()
  })
  it('rejects unsafe endpoints before opening a socket', async () => {
    for (const url of ['ws://desktop.example/api/desktop/view', `${endpoint}?token=secret`, 'wss://user:pass@desktop.example/api/desktop/view', 'wss://desktop.example/other']) {
      const h = harness('watch', async () => ({ token: 'private-token', url }))
      await tick()
      expect(h.counts().sockets).toBe(0)
      expect(h.states.at(-1)?.phase).toBe('error')
      h.stop()
    }
  })
})
