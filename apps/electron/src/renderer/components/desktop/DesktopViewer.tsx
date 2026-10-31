import { useEffect, useRef, useState } from 'react'
import { Maximize, Minimize, Monitor } from 'lucide-react'
import { connectDesktop, type DesktopMode, type DesktopState } from './desktop-connection'

interface Props { workspaceId: string; sessionId: string }

/** Full-window surface shared by Electron and WebUI. The scope key ensures that a
 * new session always starts in View only, never carrying a previous Control intent. */
export function DesktopViewer(props: Props) {
  return <DesktopSurface key={`${props.workspaceId}:${props.sessionId}`} {...props} />
}

function DesktopSurface({ workspaceId, sessionId }: Props) {
  const root = useRef<HTMLDivElement>(null)
  const target = useRef<HTMLDivElement>(null)
  const dispose = useRef<(() => void) | null>(null)
  const [request, setRequest] = useState<{ id: number; mode: DesktopMode }>({ id: 0, mode: 'watch' })
  const [state, setState] = useState<DesktopState>({ phase: 'requesting', message: 'Connecting…' })
  const [controlAvailable, setControlAvailable] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [now, setNow] = useState(Date.now)
  const controlling = state.phase === 'control'
  const busy = state.phase === 'requesting' || state.phase === 'connecting'
  const connected = controlling || state.phase === 'watch'

  useEffect(() => {
    const container = target.current
    if (!container) return
    const disconnect = connectDesktop({
      mode: request.mode,
      grant: () => window.electronAPI.getDesktopViewerGrant(sessionId, location.origin, request.mode),
      loadRfb: async () => {
        // @ts-expect-error noVNC does not ship TypeScript declarations
        const { default: RFB } = await import('@novnc/novnc/lib/rfb.js')
        return socket => new RFB(container, socket, { shared: true })
      },
      onState: next => {
        // Only a current successful watch grant can advertise this UX capability.
        // Server grant/socket confirmation remain the independent auth boundary.
        if (request.mode === 'watch') setControlAvailable(next.phase === 'watch' && next.controlAvailable === true)
        setState(next)
      },
    })
    dispose.current = disconnect
    const stop = () => { disconnect(); window.electronAPI.setDesktopInputActive(false) }
    window.addEventListener('pagehide', stop)
    return () => {
      stop()
      window.removeEventListener('pagehide', stop)
      container.replaceChildren()
      if (dispose.current === disconnect) dispose.current = null
    }
  }, [request, workspaceId, sessionId])

  // No AppShell/action-registry keyboard handlers run in this window. Only a
  // focused, confirmed-control canvas bypasses local native menu accelerators.
  useEffect(() => {
    const update = () => window.electronAPI.setDesktopInputActive(controlling && document.hasFocus() && !!target.current?.contains(document.activeElement))
    document.addEventListener('focusin', update)
    document.addEventListener('focusout', update)
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    update()
    return () => {
      document.removeEventListener('focusin', update)
      document.removeEventListener('focusout', update)
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
      window.electronAPI.setDesktopInputActive(false)
    }
  }, [controlling])

  useEffect(() => {
    if (!controlling) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [controlling])

  useEffect(() => {
    const update = () => setFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', update)
    return () => document.removeEventListener('fullscreenchange', update)
  }, [])

  function changeMode(mode: DesktopMode) {
    if (mode === 'control' && !controlAvailable) return // preserve the working watch stream
    if (mode === 'watch') setControlAvailable(false)
    // Immediate fail-closed downgrade, before React effects/RPCs run. A late ready
    // from the prior generation cannot re-enable input after Return/close.
    dispose.current?.()
    window.electronAPI.setDesktopInputActive(false)
    setState({ phase: 'requesting', message: mode === 'watch' ? 'Connecting…' : 'Taking control…' })
    setRequest(previous => ({ id: previous.id + 1, mode }))
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await root.current?.requestFullscreen()
    } catch { /* Native maximize/resize remains available when fullscreen is unsupported. */ }
  }

  const remainingSeconds = Math.max(0, Math.ceil(((state.controlExpiresAt ?? now) - now) / 1000))
  const countdown = `${Math.floor(remainingSeconds / 60)}:${String(remainingSeconds % 60).padStart(2, '0')}`

  return <div ref={root} className="flex h-dvh min-h-0 flex-col bg-background text-foreground">
    <header className="flex shrink-0 flex-wrap items-center gap-3 border-b px-4 py-3">
      <h1 className="mr-auto flex items-center gap-2 text-sm font-medium"><Monitor className="size-4" />Desktop</h1>
      <div role="group" aria-label="Desktop interaction" className="flex rounded-md border p-0.5 text-sm">
        <button aria-pressed={!controlling} className={`rounded px-3 py-1.5 ${!controlling ? 'bg-foreground/10 font-medium' : ''}`} onClick={() => changeMode('watch')} disabled={state.phase === 'watch' || (busy && request.mode === 'watch')}>View only</button>
        <button aria-pressed={controlling} title={controlAvailable ? 'Request Control' : 'Control is not available on this server yet.'} className={`rounded px-3 py-1.5 disabled:opacity-40 ${controlling ? 'bg-foreground/10 font-medium' : ''}`} onClick={() => changeMode('control')} disabled={!controlAvailable || controlling || busy}>Control</button>
      </div>
      <button aria-label={fullscreen ? 'Exit full screen' : 'Full screen'} title={fullscreen ? 'Exit full screen' : 'Full screen'} className="rounded p-2 hover:bg-foreground/5" onClick={() => { void toggleFullscreen() }}>{fullscreen ? <Minimize className="size-4" /> : <Maximize className="size-4" />}</button>
    </header>
    <div ref={target} className={`relative min-h-0 flex-1 overflow-hidden bg-background ${controlling ? '' : 'pointer-events-none'}`} aria-label={controlling ? 'Desktop display — click to control' : 'Desktop display — view only'} />
    {(state.message || controlling || (!busy && !connected)) && <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t px-4 py-2 text-xs">
      <p role="status" aria-live="polite" aria-busy={busy}>{state.message}{controlling && <span aria-live="off">{countdown}</span>}</p>
      {!busy && !connected && <button className="rounded border px-3 py-1.5" onClick={() => changeMode('watch')}>Reconnect</button>}
    </footer>}
  </div>
}
