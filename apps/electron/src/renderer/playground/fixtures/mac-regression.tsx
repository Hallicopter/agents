/** Synthetic renderer integration fixture; never connects to a user workspace.
 * Served only by the explicit regression harness, not the application entry.
 */
import React, { useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { TooltipProvider, SessionViewer } from '@craft-agent/ui'
import type { StoredSession } from '@craft-agent/core'
import en from '../../../../../../packages/shared/src/i18n/locales/en.json'
import { WorkLog } from '../../../../../../packages/ui/src/components/chat/turn/WorkLog'
import { MessageBubble } from '../../components/app-shell/chat-display/MessageBubble'
import { useLabels } from '../../hooks/useLabels'
import { useStatuses } from '../../hooks/useStatuses'
import { useViews } from '../../hooks/useViews'
import { ThemeProvider } from '../../context/ThemeContext'
import { SessionListProvider, type SessionListContextValue } from '../../context/SessionListContext'
import { SessionBadges } from '../../components/app-shell/SessionBadges'
import { filterSessionLabelsAndStatus } from '../../components/app-shell/filter-session-labels-and-status'
import type { SessionMeta } from '../../atoms/sessions'
import '../../index.css'

void i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en } }, keySeparator: false, interpolation: { escapeValue: false } })

export const raw = '[Message from session "261030-lean-birch" (ops stuff)]\nUse send_agent_message with sessionId "261030-lean-birch" to reply.\n\n---\n\nRELEASE SUCCEEDED — synthetic fixture only.\n\nFull raw details and [artifact](https://example.com/report).'
document.documentElement.style.height = 'auto'
document.body.style.overflow = 'auto'
document.body.style.height = 'auto'

const listeners = { labels: new Set<(id: string) => void>(), statuses: new Set<(id: string) => void>(), transport: new Set<(s: any) => void>() }
const calls: string[] = []
let online = false
let heldWorkspace: string | null = null
const pending: Array<() => void> = []
const labels = [{ id: 'puck', name: 'Puck', children: [{ id: 'puck-subagent', name: 'Puck Subagent' }] }, { id: 'puck-automation', name: 'Puck Automation' }]
const listen = (set: Set<any>, fn: any) => { set.add(fn); return () => { set.delete(fn) } }
async function load<T>(kind: string, workspace: string, data: T): Promise<T> {
  calls.push(`${workspace}:${kind}`)
  if (!online) throw new Error('Synthetic disconnected transport')
  if (workspace === heldWorkspace) await new Promise<void>(resolve => pending.push(resolve))
  return data
}
window.electronAPI = {
  listLabels: (id: string) => load('labels', id, id === 'b' ? [{ id: 'other', name: 'Other workspace' }] : labels),
  listStatuses: (id: string) => load('statuses', id, [{ id: 'todo', label: 'Todo', category: 'open' }, { id: 'needs-review', label: 'Review', category: 'open' }]),
  listViews: (id: string) => load('views', id, [{ id: 'review', name: 'Review', expression: 'sessionStatus == "needs-review"' }]),
  onLabelsChanged: (fn: (id: string) => void) => listen(listeners.labels, fn),
  onStatusesChanged: (fn: (id: string) => void) => listen(listeners.statuses, fn),
  onTransportConnectionStateChanged: (fn: (s: any) => void) => { fn({ status: online ? 'connected' : 'disconnected' }); return listen(listeners.transport, fn) },
} as unknown as typeof window.electronAPI
const sessionMetas = [
  { id: 'parent', labels: ['puck'] },
  { id: 'worker', labels: ['puck-subagent::42'], sessionStatus: 'needs-review' },
  { id: 'auto', labels: ['puck-automation'], sessionStatus: 'todo' },
  { id: 'plain', sessionStatus: 'todo' },
] as SessionMeta[]
const fixture: any = {
  raw, calls, links: [], files: [],
  connect: () => { online = true; listeners.transport.forEach(fn => fn({ status: 'connected' })) },
  disconnect: () => { online = false; listeners.transport.forEach(fn => fn({ status: 'disconnected' })) },
  labelsChanged: (id: string) => listeners.labels.forEach(fn => fn(id)),
  hold: (id: string | null) => { heldWorkspace = id },
  release: () => { heldWorkspace = null; pending.splice(0).forEach(fn => fn()) },
  listenerCount: () => Object.values(listeners).reduce((n, s) => n + s.size, 0),
}
;(window as any).__fixture = fixture
function App() {
  const [workspace, setWorkspace] = useState<string | null>('a')
  const [content, setContent] = useState(raw)
  const [expanded, setExpanded] = useState(false)
  const [filter, setFilter] = useState(false)
  const labelState = useLabels(workspace)
  const statusState = useStatuses(workspace)
  const views = useViews(workspace)
  // Same production secondary-filter helper and view evaluator, stable metadata.
  const filtered = filterSessionLabelsAndStatus(filter ? sessionMetas.filter(s => views.evaluateSession(s).length > 0) : sessionMetas, filter ? new Map([['needs-review', 'include']]) : new Map(), new Map([['puck', 'include']]), labelState.labels)
  const viewMatches = useMemo(() => sessionMetas.filter(s => views.evaluateSession(s).length).length, [views.evaluateSession])
  fixture.workspace = setWorkspace
  fixture.update = setContent
  fixture.filter = setFilter
  fixture.state = { labels: labelState.flatLabels.map(l => l.id), error: labelState.error, statuses: statusState.statuses.length, views: views.viewConfigs.length, viewMatches, count: filtered.length, ids: filtered.map(s => s.id), workspace }
  return <TooltipProvider><main style={{ maxWidth: 800, margin: '32px auto', padding: 20 }}>
    <h1>Mac regression fixture — synthetic, not remote M1 proof</h1>
    <p>Real renderer components, mocked RPC. No user state.</p>
    <section aria-label="Metadata"><pre data-testid="metadata">{JSON.stringify(fixture.state, null, 2)}</pre></section>
    <section data-testid="assignments"><SessionListProvider value={{ flatLabels: labelState.flatLabels, labels: labelState.labels } as SessionListContextValue}>{sessionMetas.map(item => <div key={item.id} data-session={item.id}><span>{item.id}</span><SessionBadges item={item} /></div>)}</SessionListProvider></section>
    <section data-testid="work-log"><WorkLog activityCount={4} preview={{ text: 'Diagnose missing labels' }} failedCount={0} isExpanded={expanded} onToggle={() => setExpanded(v => !v)} activities={[]} groupedActivities={null} lastChildSet={new Set()} expandedActivityGroups={new Set()} onExpandedActivityGroupsChange={() => {}} displayMode="detailed" animateInserts={false} listRef={null} /></section>
    <section data-testid="incoming"><MessageBubble message={{ id: 'incoming', role: 'user', content, timestamp: 1, attachments: [{ id: 'report', name: 'report.txt', type: 'text', storedPath: '/fixture/report.txt', mimeType: 'text/plain', size: 20 }] }} onOpenFile={path => fixture.files.push(path)} onOpenUrl={url => fixture.links.push(url)} /></section>
    <section data-testid="ordinary"><MessageBubble message={{ id: 'ordinary', role: 'user', content: 'Ordinary user message remains a bubble.', timestamp: 2 }} onOpenFile={() => {}} onOpenUrl={() => {}} /></section>
    <section data-testid="historical" style={{ height: 180 }}><SessionViewer session={{ id: 'history', messages: [{ id: 'history-msg', type: 'user', content: raw, timestamp: 1 }] } as StoredSession} /></section>
  </main></TooltipProvider>
}
const root = createRoot(document.getElementById('root')!)
fixture.unmount = () => root.unmount()
root.render(<ThemeProvider defaultMode="light"><App /></ThemeProvider>)
