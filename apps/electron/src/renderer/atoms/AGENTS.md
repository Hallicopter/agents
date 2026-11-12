# Session state publication

`updateSessionAtom` always writes full per-session state, but publishes `sessionMetaMapAtom` only when an extracted metadata field changes. Treat nested session fields as immutable; new array/object metadata references conservatively invalidate the list. Compare every extracted field, not a hand-maintained subset that can miss new badges/filter fields.

Event consumers in `App.tsx` must not republish the metadata map after calling `updateSessionAtom`: it already updates transcript and metadata atomically. Do not throttle/drop terminal, permission, tool, or streaming events to reduce invalidations.

Regression tests: `bun test apps/electron/src/renderer/atoms/__tests__/sessions.test.ts apps/electron/src/renderer/atoms/__tests__/session-metadata-publication.test.ts`.
Offline synthetic timing: `bun scripts/bench-session-metadata.ts 1000 2000 1000`. This measures the actual processor/action plus an AppShell-style filtering observer, not React DOM, backend ACK latency, or live user experience.
