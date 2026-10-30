import { useEffect, useRef, useState } from 'react'
import { Monitor, LockKeyhole } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog'

interface Props { open: boolean; onOpenChange: (open: boolean) => void; workspaceId: string | null; sessionId?: string | null }

/** Shared Electron/WebUI shell. Grants use the existing authenticated workspace RPC.
 * No URL entry, credentials, clipboard, takeover, or automatic reconnection.
 */
export function DesktopViewer({ open, onOpenChange, workspaceId, sessionId }: Props) {
  const target = useRef<HTMLDivElement>(null)
  const [attempt, setAttempt] = useState(0)
  const [status, setStatus] = useState('Not connected')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!open || !attempt || !workspaceId || !sessionId) return
    const container = target.current
    if (!container) return
    let cancelled = false
    let socket: WebSocket | undefined
    let rfb: { disconnect(): void } | undefined
    const timeout = setTimeout(() => { if (cancelled) return; cancelled = true; rfb?.disconnect(); socket?.close(); setStatus('Desktop unavailable — connection timed out'); setBusy(false) }, 15_000)
    setBusy(true)
    setStatus('Requesting private watch-only access…')
    void (async () => {
      // Load code before opening the socket so the greeting cannot race the import.
      // @ts-expect-error noVNC does not ship TypeScript declarations
      const { default: RFB } = await import('@novnc/novnc/lib/rfb.js')
      if (cancelled) return
      const { token, url } = await window.electronAPI.getDesktopViewerGrant(sessionId, location.origin)
      const endpoint = new URL(url)
      if (endpoint.protocol !== 'wss:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/api/desktop/view') throw new Error('Invalid endpoint')
      if (cancelled || typeof token !== 'string') return
      socket = new WebSocket(url)
      socket.onopen = () => socket!.send(JSON.stringify({ token }))
      socket.onmessage = event => {
        if (cancelled) return
        try {
          if (typeof event.data !== 'string' || JSON.parse(event.data).ready !== true) throw new Error()
          const viewer = new RFB(container, socket, { shared: true })
          rfb = viewer
          viewer.viewOnly = true // UX only — gateway independently enforces read-only.
          viewer.scaleViewport = true
          viewer.resizeSession = false
          viewer.showDotCursor = false
          viewer.addEventListener('connect', () => { clearTimeout(timeout); setStatus('Watching · read-only'); setBusy(false) })
          viewer.addEventListener('disconnect', () => { clearTimeout(timeout); if (!cancelled) { setStatus('Disconnected — reconnect explicitly'); setBusy(false) } })
          viewer.addEventListener('credentialsrequired', () => viewer.disconnect())
        } catch { socket?.close(); setStatus('Desktop unavailable'); setBusy(false) }
      }
      socket.onerror = () => { if (!cancelled) { setStatus('Desktop unavailable'); setBusy(false) } }
      socket.onclose = () => { clearTimeout(timeout); if (!cancelled) { setStatus('Disconnected — reconnect explicitly'); setBusy(false) } }
    })().catch(() => { clearTimeout(timeout); if (!cancelled) { setStatus('Desktop unavailable — secure gateway is not configured or access was denied'); setBusy(false) } })
    return () => { cancelled = true; clearTimeout(timeout); rfb?.disconnect(); socket?.close(); container.replaceChildren() }
  }, [open, attempt, workspaceId, sessionId])

  // Scope changes close the prior stream; never silently attach to another session.
  useEffect(() => { setAttempt(0); setBusy(false); setStatus('Not connected') }, [open, workspaceId, sessionId])
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-5xl">
      <DialogTitle className="flex items-center gap-2"><Monitor className="size-5" /> Desktop <span className="text-xs text-muted-foreground">Watch only</span></DialogTitle>
      <DialogDescription>View the existing private desktop. Viewing does not take control, change the signed-in profile, or stop existing CUA tools.</DialogDescription>
      <div ref={target} className="h-[55vh] min-h-64 overflow-hidden rounded-lg bg-background" aria-label="Read-only desktop display" />
      <div className="flex items-center justify-between gap-4 text-sm">
        <p role="status" className="flex items-center gap-2"><LockKeyhole className="size-4 shrink-0" />{!sessionId ? 'Select a session to view its entitled desktop' : status}</p>
        <button className="shrink-0 rounded-md border px-3 py-2 disabled:opacity-40" disabled={!workspaceId || !sessionId || busy} onClick={() => setAttempt(n => n + 1)}>Open watch viewer</button>
      </div>
      <p className="text-xs text-muted-foreground">Deployment is disabled by default. No clipboard, keyboard, mouse input, or desktop resizing. Closing this panel disconnects only this viewer.</p>
    </DialogContent>
  </Dialog>
}
