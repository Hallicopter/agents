# Incoming session envelopes

`UserMessageBubble` opts into strict envelope recognition only at transcript call sites (Electron `MessageBubble` and shared `SessionViewer`); previews/composers remain ordinary user messages. Do not weaken `parseIncomingAgentEnvelope` or rewrite stored/model-visible content.

Incoming envelopes use the actual thinking/tool `WorkLogDisclosure` and `WorkLogHeader`. The whole raw body and all attachments belong inside it, never a surrounding user bubble or collapsed body excerpt. Copy uses the exact original content. Use stable message identity, not content as a React key, so live updates retain expansion. Expanded raw text must not be hidden by context badge substitution.

`WorkLogDisclosure` is shared with `WorkLog`, but only tool logs opt out of transcript search. Keep header keyboard, focus, light/dark and compact behavior unified. Attachment previews are keyboard-operable buttons. Browser integration fixtures verify live and historical transcript paths with synthetic data.

# Completed turn structural sharing

`reuseUnchangedTurns` compares all derived fields and only reuses complete, non-streaming assistant turns. `ChatDisplay` keeps one latest per-panel result and resets across session identities; do not add global history/ID-only caches. Completed text, annotations, tool output, todos, retractions and future fields must still invalidate. Active turns always stay fresh. Tests: `bun test packages/ui/src/components/chat/__tests__/turn-sharing.test.ts`.

`TurnCard` keeps a tiny outer action bridge around its heavy memoized body. Publish latest callback props only after commit (browser layout effect), revoke on unmount, and preserve callback absence/capability in the inner comparator. Never let a suspended/aborted render replace committed branch settings, follow-up send guards, annotation handlers or expansion keys. Compare visible/interaction primitives (`sendMessageKey`, folder path, intent/todos, etc.) explicitly rather than comparing every inline event callback identity. Regressions: `turn-action-bridge.test.ts` and fixture `action-check` (includes real Suspense/startTransition).
