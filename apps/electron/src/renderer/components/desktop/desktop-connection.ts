export type DesktopMode = 'watch' | 'control'
export interface DesktopGrant { token: string; url: string; mode?: DesktopMode; expiresAt?: number; controlAvailable?: boolean }
export interface DesktopState {
  phase: 'requesting' | 'connecting' | 'watch' | 'control' | 'disconnected' | 'error'
  message: string
  controlExpiresAt?: number
  /** Discovery hint only; never authorization to send input. Missing means unavailable. */
  controlAvailable?: boolean
}
export interface DesktopRfb {
  viewOnly: boolean
  scaleViewport: boolean
  resizeSession: boolean
  showDotCursor: boolean
  focusOnClick: boolean
  disconnect(): void
  blur(): void
  addEventListener(name: string, listener: () => void): void
}
interface Options {
  mode: DesktopMode
  grant(): Promise<DesktopGrant>
  loadRfb(): Promise<(socket: WebSocket) => DesktopRfb>
  socket?(url: string): WebSocket
  onState(state: DesktopState): void
  timeoutMs?: number
}

const controlUnavailable = 'Control unavailable. Try again.'

/** One explicit connection attempt. Disposal invalidates every async continuation, including
 * late grants/ready/connect events. Never retries, reconnects, or retains credentials. */
export function connectDesktop(options: Options): () => void {
  let active = true
  let socket: WebSocket | undefined
  let viewer: DesktopRfb | undefined
  let expiry: ReturnType<typeof setTimeout> | undefined
  const timeout = setTimeout(() => finish('error', options.mode === 'control'
    ? 'Control request timed out. Return to View only, or try Control again later.'
    : 'Desktop connection timed out. Reconnect to try again.'), options.timeoutMs ?? 15_000)

  function dispose() {
    if (!active) return
    active = false
    clearTimeout(timeout)
    clearTimeout(expiry)
    if (viewer) { viewer.viewOnly = true; viewer.blur(); viewer.disconnect() }
    socket?.close()
  }
  function finish(phase: 'error' | 'disconnected', message: string) {
    if (!active) return
    dispose()
    options.onState({ phase, message })
  }

  options.onState({ phase: 'requesting', message: options.mode === 'control'
    ? 'Taking control…'
    : 'Connecting…' })
  void (async () => {
    // Load code before opening the socket so the greeting cannot race the import.
    const createRfb = await options.loadRfb()
    if (!active) return
    const grant = await options.grant()
    if (!active) return
    const endpoint = new URL(grant.url)
    if (endpoint.protocol !== 'wss:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/api/desktop/view' || typeof grant.token !== 'string' || !grant.token) throw new Error('Invalid endpoint')
    if (options.mode === 'control' && grant.mode !== 'control') throw new Error('Control not granted')
    socket = (options.socket ?? (url => new WebSocket(url)))(grant.url)
    // Credentials exist only in this attempt's memory; never put them in a URL or log.
    socket.onopen = () => { if (active) { socket!.send(JSON.stringify({ token: grant.token })); grant.token = '' } }
    socket.addEventListener('error', () => finish('error', options.mode === 'control' ? controlUnavailable : 'Desktop unavailable. Check access and the secure gateway, then reconnect.'))
    socket.addEventListener('close', () => finish('disconnected', 'Disconnected.'))
    socket.onmessage = event => {
      if (!active) return
      try {
        if (typeof event.data !== 'string') throw new Error('Invalid ready')
        const ready = JSON.parse(event.data)
        if (ready.ready !== true) throw new Error('Not ready')
        const confirmedControl = options.mode === 'control' && ready.mode === 'control'
        // Old gateways confirm watch with {ready:true}; never mistake that for Control.
        if (options.mode === 'control' && !confirmedControl) throw new Error('Control not confirmed')
        const duration = ready.controlDurationMs
        const controlExpiresAt = duration === undefined ? ready.controlExpiresAt : Date.now() + duration
        if (confirmedControl && duration !== undefined && (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 || duration > 300_000)) throw new Error('Invalid control duration')
        if (confirmedControl && (typeof controlExpiresAt !== 'number' || !Number.isFinite(controlExpiresAt) || controlExpiresAt <= Date.now() || controlExpiresAt > Date.now() + 5 * 60_000)) throw new Error('Invalid control expiry')
        socket!.onmessage = null
        viewer = createRfb(socket!)
        const current = viewer
        current.viewOnly = true // Remains true through RFB negotiation.
        current.scaleViewport = true
        current.resizeSession = false
        current.showDotCursor = false
        current.focusOnClick = false
        options.onState({ phase: 'connecting', message: 'Connecting…', controlAvailable: false })
        current.addEventListener('connect', () => {
          if (!active) { current.viewOnly = true; current.disconnect(); return }
          if (confirmedControl && controlExpiresAt <= Date.now()) { finish('disconnected', 'Control ended before connection completed. Return to View only.'); return }
          clearTimeout(timeout)
          current.viewOnly = !confirmedControl
          current.focusOnClick = confirmedControl
          options.onState({ phase: confirmedControl ? 'control' : 'watch', message: '', controlAvailable: options.mode === 'watch' && grant.controlAvailable === true, ...(confirmedControl ? { controlExpiresAt } : {}) })
          if (confirmedControl) {
            expiry = setTimeout(() => finish('disconnected', 'Control ended. Reconnect in View only, or explicitly request Control again.'), Math.max(0, controlExpiresAt - Date.now()))
          }
        })
        current.addEventListener('disconnect', () => finish('disconnected', 'Disconnected.'))
        current.addEventListener('credentialsrequired', () => finish('error', 'Desktop authentication failed. Check the secure gateway, then reconnect.'))
        current.addEventListener('securityfailure', () => finish('error', 'Desktop authentication failed. Check the secure gateway, then reconnect.'))
      } catch { finish('error', options.mode === 'control' ? controlUnavailable : 'Desktop unavailable. Check access and the secure gateway, then reconnect.') }
    }
  })().catch(() => finish('error', options.mode === 'control' ? controlUnavailable : 'Desktop unavailable. Check access and the secure gateway, then reconnect.'))
  return dispose
}
