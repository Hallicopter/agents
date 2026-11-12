// Must precede imports of production surfaces that read electronAPI at module load.
import '../../../apps/electron/src/renderer/playground/mock-utils'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { atom, Provider, useAtomValue, useStore } from 'jotai'
import { setupI18n } from '@craft-agent/shared/i18n'
import { initReactI18next } from 'react-i18next'
import { TooltipProvider } from '@craft-agent/ui'
import { ThemeProvider } from '@/context/ThemeContext'
import { PlaygroundAppShellProvider } from '@/playground/PlaygroundAppShellProvider'
import { PlaygroundSessionProviders } from '@/playground/PlaygroundSessionProviders'
import { ChatDisplay } from '@/components/app-shell/ChatDisplay'
import { SessionList } from '@/components/app-shell/SessionList'
import { MOCK_SESSION_STATUSES } from '@/playground/demos/mobile-webui/mock-mobile-data'
import { extractSessionMeta, initializeSessionsAtom, sessionAtomFamily, sessionMetaMapAtom, updateSessionAtom } from '@/atoms/sessions'
import { processEvent } from '@/event-processor/processor'
import type { AgentEvent, StreamingState } from '@/event-processor/types'
import type { Session } from '../../../apps/electron/src/shared/types'
import '../../../apps/electron/src/renderer/index.css'

setupI18n([initReactI18next])
const workspaceId = 'synthetic-performance'
const now = Date.now()
const noop = () => {}
// Historical write body, used ONLY by this offline comparison fixture.
const baselineUpdate = atom(null, (get, set, id: string, updater: (prev: Session | null) => Session | null) => {
  const target = sessionAtomFamily(id)
  const next = updater(get(target))
  set(target, next)
  if (next) {
    const map = new Map(get(sessionMetaMapAtom))
    map.set(id, extractSessionMeta(next))
    set(sessionMetaMapAtom, map)
  }
})

function createSession(i: number): Session {
  return {
    id: `synthetic-${i}`, workspaceId, workspaceName: 'Synthetic performance', name: i === 10 ? 'Draft stays responsive while background chats stream' : `Synthetic session ${i}`,
    permissionMode: 'ask', sessionStatus: 'todo', isProcessing: i < 10,
    createdAt: now - i * 1000, lastMessageAt: now - i * 1000,
    lastFinalMessageId: `final-${i}`, messageCount: i < 10 ? 1001 : 2,
    messages: i < 10 ? [
      ...Array.from({ length: 1000 }, (_, n) => ({ id: `history-${i}-${n}`, role: (n % 2 ? 'assistant' : 'user') as 'assistant' | 'user', content: 'Synthetic history. '.repeat(8), timestamp: now - 2000000 + n })),
      { id: `stream-${i}`, role: 'assistant', content: '', isStreaming: true, turnId: `turn-${i}`, timestamp: now },
    ] : [
      { id: `question-${i}`, role: 'user', content: 'Can I keep this draft while the other sessions are busy?', timestamp: now - 2000 },
      { id: `final-${i}`, role: 'assistant', content: 'Yes. Type a draft below, then run the background-stream workload. This is the production ChatDisplay and SessionList on an isolated in-memory store. No message is sent to a server.', timestamp: now - 1000 },
    ],
  }
}

function Fixture() {
  const store = useStore()
  const [ready, setReady] = useState(false)
  const [selected, setSelected] = useState('synthetic-10')
  const [baseline, setBaseline] = useState(false)
  const [draft, setDraft] = useState('This draft must survive background traffic.')
  const [result, setResult] = useState('Ready: 1,000 sessions; 10 streams with 1,000-message histories.')
  const counters = useRef({ metadata: 0, transcript: 0 })
  const streaming = useRef(new Map<string, StreamingState | null>())
  const metaMap = useAtomValue(sessionMetaMapAtom)
  const session = useAtomValue(sessionAtomFamily(selected))
  const items = useMemo(() => Array.from(metaMap.values()).filter(s => !s.hidden && s.workspaceId === workspaceId).filter(s => !s.isArchived), [metaMap])

  useEffect(() => {
    store.set(initializeSessionsAtom, Array.from({ length: 1000 }, (_, i) => createSession(i)))
    const unsubMeta = store.sub(sessionMetaMapAtom, () => { counters.current.metadata++ })
    const unsubSessions = Array.from({ length: 10 }, (_, i) => store.sub(sessionAtomFamily(`synthetic-${i}`), () => { counters.current.transcript++ }))
    setReady(true)
    return () => { unsubMeta(); unsubSessions.forEach(unsub => unsub()) }
  }, [store])

  function dispatch(event: AgentEvent) {
    const id = event.sessionId
    const { state } = processEvent({ session: store.get(sessionAtomFamily(id))!, streaming: streaming.current.get(id) ?? null }, event)
    streaming.current.set(id, state.streaming)
    store.set(baseline ? baselineUpdate : updateSessionAtom, id, () => state.session)
  }

  async function burst() {
    // Identical histories/content for each comparison; reset is outside timing.
    store.set(initializeSessionsAtom, Array.from({ length: 1000 }, (_, i) => createSession(i)))
    streaming.current.clear()
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    counters.current = { metadata: 0, transcript: 0 }
    const start = performance.now()
    // A zero-delay timer measures synthetic renderer-loop blocking, NOT backend ACK.
    const timer = new Promise<number>(resolve => setTimeout(() => resolve(performance.now() - start), 0))
    for (let n = 0; n < 2000; n++) {
      const i = n % 10
      dispatch({ type: 'text_delta', sessionId: `synthetic-${i}`, turnId: `turn-${i}`, delta: 'token ' })
    }
    const dispatchMs = performance.now() - start
    const timerMs = await timer
    const snapshot = { mode: baseline ? 'base-action' : 'fixed-action', dispatchMs, timerMs, ...counters.current,
      characters: Array.from({ length: 10 }, (_, i) => store.get(sessionAtomFamily(`synthetic-${i}`))!.messages.at(-1)!.content.length).reduce((a, b) => a + b, 0) }
    ;(window as any).__metadataFixtureResult = snapshot
    setResult(JSON.stringify(snapshot))
  }

  function finish() {
    for (let i = 0; i < 10; i++) {
      const id = `synthetic-${i}`
      dispatch({ type: 'text_complete', sessionId: id, turnId: `turn-${i}`, text: `Background ${i} finished — final text preserved.`, messageId: `completed-${i}` })
      dispatch({ type: 'complete', sessionId: id, hasUnread: true })
    }
    setResult('Complete: all 10 processing indicators clear; unread badges and final replies published. Select a background chat to inspect.')
  }

  if (!ready) return <div>Initializing isolated synthetic data…</div>
  return <div className="h-screen flex flex-col bg-background text-foreground">
    <header className="p-3 border-b text-sm space-y-2">
      <strong>Isolated actual UI — synthetic renderer workload (no server/RPC)</strong>
      <div className="flex gap-4 items-center">
        <label><input type="checkbox" checked={baseline} onChange={e => setBaseline(e.target.checked)} /> Use base-commit metadata publication</label>
        <button className="border rounded px-3 py-1" onClick={() => void burst()}>Run 2,000 background deltas</button>
        <button className="border rounded px-3 py-1" onClick={finish}>Complete background turns</button>
        <button className="border rounded px-3 py-1" onClick={() => setSelected('synthetic-10')}>Open draft chat</button>
      </div>
      <output className="block text-xs" aria-live="polite">{result}</output>
    </header>
    <div className="flex flex-1 min-h-0">
      <aside className="w-80 border-r flex flex-col min-h-0">
        <SessionList items={items} workspaceId={workspaceId} focusedSessionId={selected} onNavigateToSession={setSelected}
          onDelete={async () => false} onMarkUnread={noop} onSessionStatusChange={noop} onRename={noop}
          sessionStatuses={MOCK_SESSION_STATUSES} groupingMode="unread" />
      </aside>
      <main className="flex-1 min-w-0 flex flex-col">
        <ChatDisplay session={session} onSendMessage={() => setResult('Offline fixture: no send was performed.')}
          onOpenFile={noop} onOpenUrl={noop} currentModel="haiku" onModelChange={noop} permissionMode="ask"
          inputValue={draft} onInputChange={setDraft} workspaceId={workspaceId} sources={[]} skills={[]} />
      </main>
    </div>
  </div>
}

createRoot(document.getElementById('root')!).render(
  <Provider><ThemeProvider defaultMode="light"><TooltipProvider><PlaygroundAppShellProvider>
    <PlaygroundSessionProviders workspaceId={workspaceId} workspaceSlug="synthetic" compact={false}
      createStubSession={() => createSession(1001)}><Fixture /></PlaygroundSessionProviders>
  </PlaygroundAppShellProvider></TooltipProvider></ThemeProvider></Provider>,
)
