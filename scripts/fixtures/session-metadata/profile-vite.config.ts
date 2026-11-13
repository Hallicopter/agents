import { resolve } from 'node:path'
import base from './vite.config'

// Synthetic diagnostic counters and explicit before-control switches only.
// Product source is transformed in memory, never written. No release build
// imports this config; controls are opt-in fixture query parameters.
export default {
  ...base,
  cacheDir: resolve(__dirname, '../../../node_modules/.vite-session-profile'),
  plugins: [
    { name: 'bounded-frontend-counters', enforce: 'pre' as const, transform(source: string, id: string) {
      if (id.endsWith('/apps/electron/src/renderer/components/ui/windowed-entity-groups.tsx')) {
        return source.replace('  const pinned = new Set(pinnedKeys)', `  const diag = (globalThis as any).__frontProfile;
  if (diag) diag.windowCache = () => ({ sizes: sizes.current.size, callbacks: callbacks.current.size, elements: elements.current.size, logical: model.rows.length, groups: model.groups.length, modelSize: model.size, previousSize: previousLayout.current?.size, measuredSize: layoutWindowedGroups(inputs, sizes.current).size });
  const pinned = new Set(pinnedKeys)`)
      }
      if (id.endsWith('/apps/electron/src/renderer/components/app-shell/SessionList.tsx')) {
        return source.replace('const windowed = flatRows.length > 200', 'const windowed = flatRows.length > 200 && !(globalThis as any).__frontProfile?.baselineWindowing')
      }
      if (id.endsWith('/apps/electron/src/renderer/components/ui/entity-list.tsx')) {
        return source.replace('hasGroups && windowing && viewportRef', 'hasGroups && windowing && viewportRef && (!(globalThis as any).__frontProfile?.baselineBoundary || windowing.enabled)')
      }
      if (id.endsWith('/apps/electron/src/renderer/components/app-shell/ChatDisplay.tsx')) {
        return source.replace('const turns = reuseUnchangedTurns(', 'const turns = (globalThis as any).__frontProfile?.baselineSharing ? grouped : reuseUnchangedTurns(')
      }
      if (id.endsWith('/packages/ui/src/components/markdown/Markdown.tsx')) {
        return source.replace('  // Get collapsible context if enabled', `
  const diag = (globalThis as any).__frontProfile;
  if (diag?.active) { diag.counters.markdownCalls++; diag.counters.markdownChars += children.length; }
  // Get collapsible context if enabled`)
      }
      if (id.endsWith('/packages/ui/src/components/chat/TurnCard.tsx')) {
        return source.replace('return <MemoizedTurnCard {...props} {...actions} />', 'return <MemoizedTurnCard {...props} {...((globalThis as any).__frontProfile?.baselineActions ? {} : actions)} />')
          .replace('  const turnPhase = useMemo', `
  const diag = (globalThis as any).__frontProfile;
  if (diag && response?.messageId) {
    const key = sessionId + ':' + response.messageId;
    if (!diag.cardActions.has(key)) diag.cardActions.set(key, { sessionId, messageId: response.messageId, onBranch, onSaveAndSendFollowUp });
  }
  if (diag?.active) { if (isComplete && !isStreaming) diag.counters.completedTurnRenders++; else diag.counters.activeTurnRenders++; }
  const turnPhase = useMemo`)
      }
      if (id.endsWith('/packages/ui/src/components/chat/turn-utils.ts')) {
        return source.replace('export function groupMessagesByTurn(messages: Message[], options: GroupTurnsOptions = {}): Turn[] {', `export function groupMessagesByTurn(messages: Message[], options: GroupTurnsOptions = {}): Turn[] {
  const diag = (globalThis as any).__frontProfile;
  const diagStart = performance.now();
  if (diag?.active) { diag.counters.groupCalls++; diag.counters.groupMessages += messages.length; }`).replace('  return turns', `  if (diag?.active) diag.counters.groupMs += performance.now() - diagStart;
  return turns`)
      }
    } },
    ...base.plugins!,
  ],
  server: { ...base.server, port: 5190 },
}
