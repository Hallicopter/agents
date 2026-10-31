import { useEffect, useState } from 'react'
import { useSetAtom } from 'jotai'
import { windowWorkspaceIdAtom } from '@/atoms/sessions'
import { DesktopViewer } from './DesktopViewer'

/** Minimal entry: intentionally no AppShell, action registry or global chat hotkeys.
 * Native bootstrap resolves the trusted workspace before preload runs; WebUI uses
 * its authenticated adapter. Query parameters contain scope only, never grants. */
export function DesktopWindow({ sessionId }: { sessionId: string | null }) {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const setWindowWorkspace = useSetAtom(windowWorkspaceIdAtom)
  useEffect(() => {
    let active = true
    void window.electronAPI.getWindowWorkspace().then(id => {
      if (!active) return
      if (!id) { setFailed(true); return }
      setWorkspaceId(id)
      setWindowWorkspace(id)
    }).catch(() => { if (active) setFailed(true) })
    return () => { active = false }
  }, [setWindowWorkspace])
  if (!sessionId || failed) return <p role="alert" className="p-6 text-sm">Desktop unavailable. Close this window and open Desktop from a selected session.</p>
  if (!workspaceId) return <p role="status" className="p-6 text-sm">Opening Desktop…</p>
  return <DesktopViewer workspaceId={workspaceId} sessionId={sessionId} />
}
