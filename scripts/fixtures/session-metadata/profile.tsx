// Synthetic profiling only. The actual shell is mounted, not MainApp startup,
// websocket dispatch, native shell, or real persistence/provider/backend paths.
import { mockElectronAPI } from '../../../apps/electron/src/renderer/playground/mock-utils'
import React, { Profiler, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { atom, Provider, useAtomValue, useStore } from 'jotai'
import { setupI18n } from '@craft-agent/shared/i18n'
import { initReactI18next } from 'react-i18next'
import { TooltipProvider } from '@craft-agent/ui'
import { ThemeProvider } from '@/context/ThemeContext'
import { AppShellProvider } from '@/context/AppShellContext'
import { ActionProbe } from './action-probe'
import { PlaygroundAppShellProvider, playgroundAppShellValue } from '@/playground/PlaygroundAppShellProvider'
import { PlaygroundSessionProviders } from '@/playground/PlaygroundSessionProviders'
import { AppShell } from '@/components/app-shell/AppShell'
import { ChatDisplay } from '@/components/app-shell/ChatDisplay'
import { SessionList } from '@/components/app-shell/SessionList'
import { useNavigation, routes } from '@/contexts/NavigationContext'
import { useFocusContext } from '@/context/FocusContext'
import { extractSessionMeta, initializeSessionsAtom, loadedSessionsAtom, sessionAtomFamily, sessionMetaMapAtom, updateSessionAtom } from '@/atoms/sessions'
import { processEvent } from '@/event-processor/processor'
import type { AgentEvent, StreamingState } from '@/event-processor/types'
import type { Message, Session } from '../../../apps/electron/src/shared/types'
import '../../../apps/electron/src/renderer/index.css'

setupI18n([initReactI18next])
const params = new URLSearchParams(location.search)
const count = Number(params.get('count') ?? 1000)
const history = Number(params.get('history') ?? 1000)
const richSize = Number(params.get('richSize') ?? 8)
const shell = params.get('shell') !== '0'
const legacy = params.get('legacy') === '1'
const family = params.get('family') === '1'
const workspaceId = 'synthetic-performance'
const noop = () => {}
const off = () => noop
const now = Date.now()
const drafts = new Map<string, string>()
const markdownSection = '## Findings\n\nA **representative** response with [a source](https://example.invalid) and `inline code`.\n\n| Area | Result |\n|---|---|\n| Rendering | Investigate |\n| Streaming | Preserve |\n\n- First item\n- Second item\n\n```typescript\nconst items = [1, 2, 3];\nexport const result = items.map(item => ({item, valid: true}));\n```\n\n'
function messages(id: string, length: number, kind = 'plain'): Message[] {
  return Array.from({ length }, (_, n) => ({
    id: `${id}-m-${n}`, role: n % 2 ? 'assistant' : 'user', timestamp: now - 100000 + n,
    content: n % 2 ? (kind === 'rich' ? markdownSection.repeat(richSize)
      : kind === 'large' && n === length - 1 ? markdownSection.repeat(120)
      : 'Plain synthetic response. '.repeat(4)) : `Synthetic ${id} question ${n}.`,
  }))
}
function makeSession(i: number | string): Session {
  const id = typeof i === 'number' ? `s-${i}` : i
  const background = typeof i === 'number' && i < 10
  const kind = id === 'rich' ? 'rich' : id === 'large' ? 'large' : 'plain'
  const length = id === 'idle' ? 2 : history
  const transcript = background || typeof i === 'string' ? messages(id, length, kind) : []
  if (background) transcript.push({ id: `${id}-stream`, role: 'assistant', content: '', timestamp: now + 1, isStreaming: true, turnId: id })
  return { id, workspaceId, workspaceName: 'Synthetic performance', name: `Synthetic ${id}`,
    messages: transcript, messageCount: transcript.length || history,
    lastFinalMessageId: `${id}-m-${length - 1}`, isProcessing: background,
    lastMessageAt: now - (typeof i === 'number' ? i : -1) * 1000,
    sessionStatus: 'todo', permissionMode: 'ask', createdAt: now - 200000, supportsBranching: true,
    ...(family && typeof i === 'number' && i > 0 ? { parentSessionId: 's-0' } : {}) }
}
let coldDelayMs = 0
const mockReads: any[] = []
const originalMock = window.electronAPI as any
Object.assign(originalMock, {
  getRuntimeEnvironment: () => 'web', isChannelAvailable: () => false,
  getLatestReleaseVersion: async () => null,
  getWorkspaceSettings: async () => ({}),
  getDecisionLayerStatus: async () => ({ settings: { enabled: false, provider: 'none', features: {} }, presets: [], providersWithKey: [] }),
  getSources: async () => [], getSkills: async () => [], getProjects: async () => [], getPages: async () => [],
  getAutomations: async () => null, getAutomationLastExecuted: async () => ({}),
  listStatuses: async () => [{ id: 'todo', label: 'Todo', category: 'open' }, { id: 'in-progress', label: 'In progress', category: 'open' }],
  listLabels: async () => [], listViews: async () => [],
  searchSessionContent: async () => Array.from({ length: count }, (_, i) => ({ sessionId: `s-${i}`, matchCount: 1, matches: [{ snippet: 'Synthetic search match' }] })),
  cancelSessionSearch: async () => {},
  onStatusesChanged: off, onSourcesChanged: off, onSkillsChanged: off, onProjectsChanged: off,
  onPagesChanged: off, onAutomationsChanged: off, onUnreadSummaryChanged: off,
  getUnreadSummary: async () => ({ hasUnreadByWorkspace: {} }),
  getWindowFocusState: async () => true, onWindowFocusChange: off,
  onTransportConnectionStateChanged: (fn: any) => { fn({ status: 'connected' }); return noop },
  getSessionMessages: async (id: string) => {
    const begin = performance.now()
    if (coldDelayMs) await new Promise(resolve => setTimeout(resolve, coldDelayMs))
    const session = makeSession(id)
    mockReads.push({ id, mockDelayMs: coldDelayMs, totalMockMs: performance.now() - begin, messages: session.messages.length })
    return session
  },
})
// There is no web adapter or live API fallback. Unknown API calls stay missing,
// so fixture coverage gaps surface as errors rather than hitting production.

const baselineUpdate = atom(null, (get, set, id: string, updater: (prev: Session | null) => Session | null) => {
  const target = sessionAtomFamily(id); const next = updater(get(target)); set(target, next)
  if (next) { const map = new Map(get(sessionMetaMapAtom)); map.set(id, extractSessionMeta(next)); set(sessionMetaMapAtom, map) }
})
const freshCounters = () => ({ metadata: 0, transcript: 0, markdownCalls: 0, markdownChars: 0, completedTurnRenders: 0, activeTurnRenders: 0, groupCalls: 0, groupMessages: 0, groupMs: 0, processorMs: 0, atomMs: 0 })
const diag: any = { ready: false, active: false, selected: 'idle', counters: freshCounters(), commits: [], longTasks: [], frames: [], inputs: [], mockReads,
  cardActions: new Map(), branches: [], submitEvents: [], probeCalls: [], probeAttempts: 0, menuActions: [],
  count, history, richSize, shell, legacy, family, baselineSharing: params.get('baselineSharing') === '1', baselineActions: params.get('baselineActions') === '1', baselineBoundary: params.get('baselineBoundary') === '1', baselineWindowing: params.get('baselineWindowing') === '1', label: 'unset' }
;(globalThis as any).__frontProfile = diag
window.addEventListener('craft:submit-input', (event: Event) => diag.submitEvents.push((event as CustomEvent).detail))
const longObserver = new PerformanceObserver(list => {
  if (diag.active) for (const task of list.getEntries()) diag.longTasks.push({ start: task.startTime, duration: task.duration })
})
longObserver.observe({ type: 'longtask', buffered: false })
let lastFrame = 0
function frame(t: number) {
  if (diag.active && lastFrame) diag.frames.push(t - lastFrame)
  lastFrame = t; requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
document.addEventListener('beforeinput', () => {
  if (!diag.active) return
  const begin = diag.pendingInput ?? performance.now()
  diag.pendingInput = undefined
  requestAnimationFrame(() => requestAnimationFrame(() => diag.inputs.push(performance.now() - begin)))
}, true)
function onRender(id: string, phase: string, actualDuration: number, baseDuration: number) {
  if (diag.active) diag.commits.push({ id, phase, actualDuration, baseDuration })
}

// Match production ChatPage's state isolation: composer state and full-session
// subscription live BELOW the sidebar/shell parent, not in the shared fixture.
function TranscriptPane({ selected }: { selected: string }) {
  const session = useAtomValue(sessionAtomFamily(selected))
  const [draft, setDraft] = useState('')
  const [guards, setGuards] = useState({ disableSend: false, connectionUnavailable: false })
  diag.setSendGuards = setGuards
  return <ChatDisplay disableSend={guards.disableSend} connectionUnavailable={guards.connectionUnavailable} session={session} onSendMessage={noop} onOpenFile={noop} onOpenUrl={noop} currentModel="haiku" onModelChange={noop} permissionMode="ask" inputValue={draft} onInputChange={setDraft} workspaceId={workspaceId} sources={[]} skills={[]} />
}

function Fixture() {
  const store = useStore()
  const navigation = useNavigation()
  const { focusZone } = useFocusContext()
  const [ready, setReady] = useState(false)
  const [selected, setSelected] = useState('idle')
  const [listGeneration, setListGeneration] = useState(0)
  const [showProbe, setShowProbe] = useState(params.get('actionProbe') === '1')
  const [searchActive, setSearchActive] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [groupingMode, setGroupingMode] = useState<'date' | 'unread'>('date')
  const streaming = useRef(new Map<string, StreamingState | null>())
  const metaMap = useAtomValue(sessionMetaMapAtom)
  const items = useMemo(() => Array.from(metaMap.values()).filter(s => !s.hidden && s.workspaceId === workspaceId).filter(s => !s.isArchived), [metaMap])
  const context = useMemo(() => ({ ...playgroundAppShellValue,
    workspaces: [{ id: workspaceId, name: 'Synthetic performance', slug: 'synthetic', rootPath: '/synthetic', createdAt: now }],
    activeWorkspaceId: workspaceId, activeWorkspaceSlug: 'synthetic', isCompactMode: false,
    getDraft: (id: string) => drafts.get(id) ?? '',
    onInputChange: (id: string, content: string) => { drafts.set(id, content) },
    onSetActiveViewingSession: noop, onMarkSessionRead: noop,
    onCreateSession: async (workspaceId: string, options?: unknown) => { diag.branches.push({ workspaceId, options }); return makeSession('branch') },
    onSendMessage: () => { throw new Error('No sends in profiling fixture') },
  }), [])

  useEffect(() => {
    const sessions = [...Array.from({ length: count }, (_, i) => makeSession(i)), ...['idle', 'plain', 'rich', 'large', 'cold'].map(id => makeSession(id))]
    store.set(initializeSessionsAtom, sessions)
    store.set(loadedSessionsAtom, new Set(sessions.map(s => s.id)))
    const unsubs = [store.sub(sessionMetaMapAtom, () => { if (diag.active) diag.counters.metadata++ }),
      // initializeSessionsAtom sorts the input array in-place; subscribe by
      // explicit stream IDs, not the first entries of that now-sorted array.
      ...Array.from({ length: 10 }, (_, i) => store.sub(sessionAtomFamily(`s-${i}`), () => { if (diag.active) diag.counters.transcript++ }))]
    diag.start = (label: string) => { diag.counters = freshCounters(); diag.commits = []; diag.longTasks = []; diag.frames = []; diag.inputs = []; diag.label = label; diag.begin = performance.now(); diag.active = true }
    diag.stop = () => { diag.active = false; return { label: diag.label, elapsedMs: performance.now() - diag.begin,
      count, history, richSize, shell, legacy, counters: diag.counters, commits: diag.commits, longTasks: diag.longTasks,
      frames: diag.frames, inputs: diag.inputs, mockReads: [...mockReads], domNodes: document.querySelectorAll('*').length,
      renderedRows: document.querySelectorAll('[data-slot="entity-row"]').length,
      markdownNodes: document.querySelectorAll('.markdown-content').length } }
    diag.select = (id: string, cold = false, delay = 0) => {
      if (cold) {
        coldDelayMs = delay
        store.set(loadedSessionsAtom, prev => { const next = new Set(prev); next.delete(id); return next })
        store.set(sessionAtomFamily(id), { ...makeSession(id), messages: [] })
      }
      diag.switchRequestedAt = performance.now()
      diag.selected = id
      setSelected(id)
      navigation.navigate(routes.view.allSessions(id))
    }
    diag.dispatch = (event: AgentEvent) => {
      const begin = performance.now()
      const { state } = processEvent({ session: store.get(sessionAtomFamily(event.sessionId))!, streaming: streaming.current.get(event.sessionId) ?? null }, event)
      streaming.current.set(event.sessionId, state.streaming)
      const mid = performance.now()
      store.set(legacy ? baselineUpdate : updateSessionAtom, event.sessionId, () => state.session)
      if (diag.active) { diag.counters.processorMs += mid - begin; diag.counters.atomMs += performance.now() - mid }
    }
    diag.pace = async (durationMs = 4000, metadataEveryMs = 0, visible = false) => {
      const start = performance.now(); let tick = 0; let nextMeta = metadataEveryMs
      while (performance.now() - start < durationMs) {
        for (let i = 0; i < 10; i++) diag.dispatch({ type: 'text_delta', sessionId: `s-${i}`, turnId: `s-${i}`, delta: ' token' })
        if (visible) diag.dispatch({ type: 'text_delta', sessionId: diag.selected, turnId: diag.selected, delta: ' token' })
        if (metadataEveryMs && performance.now() - start >= nextMeta) {
          const id = `s-${Math.floor(nextMeta / metadataEveryMs) % 10}`
          diag.dispatch({ type: 'session_status_changed', sessionId: id, sessionStatus: store.get(sessionAtomFamily(id))!.sessionStatus === 'todo' ? 'in-progress' : 'todo' })
          nextMeta += metadataEveryMs
        }
        tick++
        await new Promise(resolve => setTimeout(resolve, Math.max(0, start + tick * 50 - performance.now())))
      }
      return { ticks: tick, elapsedMs: performance.now() - start }
    }
    diag.remountList = () => setListGeneration(n => n + 1)
    diag.unmountProbe = () => setShowProbe(false)
    diag.setSearch = (query: string) => { setSearchActive(!!query); setSearchQuery(query) }
    diag.setGrouping = setGroupingMode
    diag.focusList = () => focusZone('navigator', { intent: 'keyboard', moveFocus: true })
    diag.patchSession = (id: string, patch: Partial<Session>) => store.set(updateSessionAtom, id, session => session ? { ...session, ...patch } : session)
    diag.removeRows = (start: number, end: number) => store.set(sessionMetaMapAtom, map => { const next = new Map(map); for (let i=start;i<end;i++) next.delete(`s-${i}`); return next })
    diag.addRows = (start: number, end: number) => store.set(sessionMetaMapAtom, map => { const next = new Map(map); for(let i=start;i<end;i++) next.set(`s-${i}`,extractSessionMeta(store.get(sessionAtomFamily(`s-${i}`)) ?? makeSession(i)));return next })
    diag.fixedPace = async (ticks = 40) => {
      const start = performance.now()
      for (let tick = 0; tick < ticks; tick++) {
        for (let i = 0; i < 10; i++) diag.dispatch({ type: 'text_delta', sessionId: `s-${i}`, turnId: `s-${i}`, delta: ' token' })
        diag.dispatch({ type: 'text_delta', sessionId: diag.selected, turnId: diag.selected, delta: ' token' })
        await new Promise(resolve => setTimeout(resolve, Math.max(0, start + (tick + 1) * 50 - performance.now())))
      }
      return { ticks, backgroundDeltas: ticks * 10, visibleDeltas: ticks, elapsedMs: performance.now() - start }
    }
    diag.normalizedOutput = () => store.get(sessionAtomFamily(diag.selected))!.messages.map(({ role, content, toolResult, toolInput, annotations, isStreaming, isPending, isIntermediate, turnId }) => ({ role, content, toolResult, toolInput, annotations, isStreaming, isPending, isIntermediate, turnId }))
    diag.ready = true; setReady(true)
    // Actual AppShell routes to actual ChatPage; component mode only changes fixture selection.
    navigation.navigate(routes.view.allSessions('idle'))
    return () => unsubs.forEach(off => off())
  }, [store])

  if (!ready) return <div>Initializing profiling fixture…</div>
  return <AppShellProvider value={context}><div className="h-screen flex flex-col bg-background text-foreground">
    <header className="p-2 border-b text-xs">Synthetic profiling — {shell ? 'actual AppShell → ChatPage → ChatDisplay' : 'component surfaces only'}; {count} sessions; history {history}; {legacy ? 'base metadata action' : 'reviewed fixed metadata action'}; no MainApp/RPC/backend.</header>
    <div className="flex-1 min-h-0"><Profiler id={shell ? 'AppShell' : 'components'} onRender={onRender}>
      {shell ? <AppShell contextValue={context} /> : <div className="flex h-full">
        <aside className="w-80 min-h-0 border-r flex flex-col"><SessionList key={listGeneration} items={items} workspaceId={workspaceId} searchActive={searchActive} searchQuery={searchQuery} onSearchChange={setSearchQuery} groupingMode={groupingMode} onNavigateToSession={setSelected} onDelete={async () => false} onMarkUnread={id => diag.menuActions.push({type:'mark-unread',id})} onSessionStatusChange={noop} onRename={noop} /></aside>
        <main className="flex-1 min-w-0"><TranscriptPane selected={selected} /></main>
      </div>}
    </Profiler></div>
    {showProbe && <div className="fixed bottom-0 right-0 w-64 bg-background" data-action-probe><ActionProbe /></div>}
  </div></AppShellProvider>
}

createRoot(document.getElementById('root')!).render(
  <Provider><ThemeProvider defaultMode="light"><TooltipProvider><PlaygroundAppShellProvider>
    <PlaygroundSessionProviders workspaceId={workspaceId} workspaceSlug="synthetic" compact={false} createStubSession={() => makeSession('new')}>
      <Fixture />
    </PlaygroundSessionProviders>
  </PlaygroundAppShellProvider></TooltipProvider></ThemeProvider></Provider>,
)
