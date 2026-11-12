/** Offline synthetic renderer workload; no server, histories or credentials are accessed.
 * Run: bun scripts/bench-session-metadata.ts [session-count] [events] [history-length]
 * Uses the production event processor and Jotai action. The observer reproduces
 * AppShell's workspace/archived filters, NOT a React rendering-time measurement.
 */
import { atom, createStore } from 'jotai'
import { extractSessionMeta, initializeSessionsAtom, sessionAtomFamily, sessionMetaMapAtom, updateSessionAtom } from '../apps/electron/src/renderer/atoms/sessions'
import { processEvent } from '../apps/electron/src/renderer/event-processor/processor'
import type { Session, Message } from '../apps/electron/src/shared/types'
import type { StreamingState } from '../apps/electron/src/renderer/event-processor/types'

const count = Number(process.argv[2] ?? 1000)
const events = Number(process.argv[3] ?? 2000)
const historyLength = Number(process.argv[4] ?? 1000)
const streams = Math.min(10, count)
const workspaceId = 'synthetic-workspace'

// Exact updateSessionAtom write body from b0cbdd8b, for paired comparisons in
// one runtime. No App.tsx duplicate writes are included: this is the stream path.
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

async function run(observeMetadata: boolean, baseline = false) {
  const store = createStore()
  const sessions: Session[] = Array.from({ length: count }, (_, i) => ({
    id: `synthetic-${i}`, workspaceId, workspaceName: 'Synthetic', name: `Synthetic session ${i}`,
    isProcessing: i < streams, lastFinalMessageId: `final-${i}`,
    lastMessageAt: 1700000000000 + i,
    messages: i < streams ? [
      ...Array.from({ length: historyLength }, (_, n): Message => ({
        id: `${i}-${n}`, role: n % 2 ? 'assistant' : 'user',
        content: 'Synthetic history. '.repeat(8), timestamp: 1700000000000 + n,
      })),
      { id: `stream-${i}`, role: 'assistant' as const, content: '',
        timestamp: 1700000001000, isStreaming: true, turnId: `turn-${i}` },
    ] : [],
    messageCount: i < streams ? historyLength + 1 : historyLength,
  }))
  store.set(initializeSessionsAtom, sessions)
  let metadataNotifications = 0
  let filterMs = 0
  let filteredCount = 0
  const unsubscribeMeta = observeMetadata ? store.sub(sessionMetaMapAtom, () => {
    const start = performance.now()
    metadataNotifications++
    const workspace = Array.from(store.get(sessionMetaMapAtom).values())
      .filter(s => !s.hidden && s.workspaceId === workspaceId)
    filteredCount = workspace.filter(s => !s.isArchived).length
    filterMs += performance.now() - start
  }) : () => {}
  let transcriptNotifications = 0
  const unsubscribers = Array.from({ length: streams }, (_, i) =>
    store.sub(sessionAtomFamily(`synthetic-${i}`), () => { transcriptNotifications++ }))
  const streaming = new Map<string, StreamingState | null>()
  const timerStart = performance.now()
  const timer = new Promise<number>(resolve => setTimeout(() => resolve(performance.now() - timerStart), 0))
  let processorMs = 0
  let atomMs = 0
  const start = performance.now()
  for (let n = 0; n < events; n++) {
    const i = n % streams
    const id = `synthetic-${i}`
    const beforeProcessor = performance.now()
    const { state } = processEvent({ session: store.get(sessionAtomFamily(id))!, streaming: streaming.get(id) ?? null },
      { type: 'text_delta', sessionId: id, turnId: `turn-${i}`, delta: 'token ' })
    streaming.set(id, state.streaming)
    processorMs += performance.now() - beforeProcessor
    const beforeAtom = performance.now()
    store.set(baseline ? baselineUpdate : updateSessionAtom, id, () => state.session)
    atomMs += performance.now() - beforeAtom
  }
  const totalMs = performance.now() - start
  const timerDelayMs = await timer
  const finalCharacters = Array.from({ length: streams }, (_, i) =>
    store.get(sessionAtomFamily(`synthetic-${i}`))!.messages.at(-1)!.content.length).reduce((a, b) => a + b, 0)
  unsubscribeMeta()
  unsubscribers.forEach(unsub => unsub())
  return { baseline, observeMetadata, totalMs, processorMs, atomMs, filterMs, timerDelayMs,
    metadataNotifications, transcriptNotifications, filteredCount, finalCharacters }
}

// One warm-up per variant then alternating paired runs if --compare is supplied.
// Without --compare the production action alone runs, including on the base commit.
const compare = process.argv.includes('--compare')
await run(true)
if (compare) await run(true, true)
const results = []
for (let repeat = 0; repeat < 5; repeat++) {
  if (compare) {
    // Alternate ordering to reduce host-load / warm-up bias.
    const order = repeat % 2 ? [false, true] : [true, false]
    for (const baseline of order) results.push(await run(true, baseline))
  } else {
    results.push(await run(false), await run(true))
  }
}
console.log(JSON.stringify({ runtime: Bun.version, count, streams, events, historyLength,
  workload: 'synchronous burst of existing-message text_delta events; no server/RPC or React DOM', results }, null, 2))
