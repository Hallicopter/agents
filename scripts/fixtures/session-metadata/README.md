# Session metadata publication — bounded offline reproduction

This fixture renders **production `SessionList` and `ChatDisplay`**, their existing playground providers/mocks, and the actual event processor/Jotai state. No RPC client, production server, credentials, disk histories, or external service is used. Vite binds **127.0.0.1:5187** with **no backend proxy**. The checkbox selects an exact copy of the base (`b0cbdd8b`) update action, not a second implementation of the UI. Production behavior is unchanged except the metadata-publication fix.

## Run

From a normal repository checkout with its existing dependencies installed:

```sh
bun test apps/electron/src/renderer/atoms/__tests__ apps/electron/src/renderer/event-processor/handlers
(cd apps/electron && bun run typecheck)
bun scripts/bench-session-metadata.ts 1000 2000 1000 --compare
bun node_modules/vite/bin/vite.js --config scripts/fixtures/session-metadata/vite.config.ts --configLoader runner
```

Open http://127.0.0.1:5187/ on the same machine. Or use **already-installed Chrome**, no browser download:

```sh
bun scripts/fixtures/session-metadata/check-browser.ts /absolute/path/to/artifacts
```

`CHROME_PATH` overrides the installed Chrome executable (default `/usr/bin/google-chrome`). The check uses a separate profile beneath the supplied artifacts folder, a loopback DevTools socket, and closes **only its own browser**. It types through Chrome input, runs both workloads, selects a production list row through mouse input, verifies the final reply, returns to the draft chat, and captures PNGs at 1440×900. It never sends a message. Avoid symlinking tooling/cache directories (`.vite-temp`, `.vite-*`, `.cache`) to another checkout when reusing installed dependencies. `--configLoader runner` avoids the default bundled-config temporary file entirely.

## Workload and measurements

1,000 sessions, 10 background streams, 1,000-message histories on those streams, 2,000 existing-message `text_delta` events. Each browser run resets to identical histories **outside** the timed region. No terminal/tool/permission events are batched or dropped by the fix; separate regressions cover their semantics and all extracted metadata fields, including new keys and collection references.

**Bun 1.3.11 paired runs** (five samples, alternating old/new ordering, milliseconds):

| Measurement | Base action samples | Fixed action samples |
|---|---|---|
| Processor + atom + filtering observer | 434.400, 646.854, 518.629, 510.091, 614.125 | 104.487, 163.731, 103.372, 59.912, 82.401 |
| Atom write incl. observer | 344.485, 477.442, 401.530, 451.882, 495.119 | 36.950, 45.455, 29.473, 24.950, 34.431 |
| Metadata notifications | 2,000 each | 0 each |
| Transcript notifications | 2,000 each | 2,000 each |
| Accumulated output characters | 12,000 each | 12,000 each |

The Bun observer reproduces AppShell workspace/archived filtering; it is **not** React DOM rendering. The base control excludes App.tsx's duplicate handoff/nonstreaming writes, so does not inflate the streaming result with those paths.

**One Chrome 155 dev-build sample**, same viewport and fixture (not a distribution):

| Measurement | Base action | Fixed action |
|---|---:|---:|
| Dispatch time, ms | 765.600 | 57.200 |
| Zero-delay timer elapsed, ms | 963.600 | 63.900 |
| Metadata notifications | 2,000 | 0 |
| Transcript notifications | 2,000 | 2,000 |
| Accumulated output characters | 12,000 | 12,000 |

Typed draft preserved in both bursts and across fixture session navigation; final reply, cleared processing indicators, and ten unread badges verified. An existing production nested-button React development warning is present before either action runs; no uncaught runtime exception occurred in the successful check. The fixture controls the draft in React state: this does **not** test the full application's per-session draft persistence.

## Limits

These are **synthetic synchronous stress bursts**, not production event cadence or live user-perceived send timings. Browser timer elapsed includes queued renderer work; it is not a backend timer or an ACK. There is no backend in this fixture, so the client acceptance timeout, persistence boundary, WS fanout, network, server event loop and model latency are explicitly unmeasured and unchanged. This does not establish the root cause of the reported 30-second desktop timeout or promise a corresponding end-to-end speedup. Host scheduling/GC and development-mode rendering affect timings.

The production fix is deliberately narrow: compare **every extracted enumerable metadata field** using `Object.is`; preserve the existing map identity for identical metadata; publish immediately for any changed primitive or nested reference. Always keep full transcript updates. This relies on the renderer's existing immutable-update contract. Creation/deletion, permission/notification effects, ACK/idempotency, drafts, transport and persistence logic are not changed.
