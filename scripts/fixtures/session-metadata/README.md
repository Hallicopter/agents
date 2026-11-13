# Session metadata publication — bounded offline reproduction

This fixture renders **production `SessionList` and `ChatDisplay`**, their existing playground providers/mocks, and the actual event processor/Jotai state. No RPC client, production server, credentials, disk histories, or external service is used. Vite binds **127.0.0.1:5187** with **no backend proxy**. The checkbox selects an exact copy of the base (`b0cbdd8b`) update action, not a second implementation of the UI. This first fixture isolates the metadata action; its displayed UI comes from the current checkout. Historical measurements below were taken at metadata-only commit `bd7f66f`, before the follow-on structural-sharing/windowing changes.

## Run

From a normal repository checkout with its existing dependencies installed:

```sh
bun test apps/electron/src/renderer/atoms/__tests__ apps/electron/src/renderer/event-processor/handlers
(cd apps/electron && bun run typecheck)
bun scripts/bench-session-metadata.ts 1000 2000 1000 --compare
bun node_modules/vite/bin/vite.js --config scripts/fixtures/session-metadata/vite.config.ts
```

Open http://127.0.0.1:5187/ on the same machine. Or use **already-installed Chrome**, no browser download:

```sh
bun scripts/fixtures/session-metadata/check-browser.ts /absolute/path/to/artifacts
```

`CHROME_PATH` overrides the installed Chrome executable (default `/usr/bin/google-chrome`). The check uses a separate profile beneath the supplied artifacts folder, a loopback DevTools socket, and closes **only its own browser**. It types through Chrome input, runs both workloads, selects a production list row through mouse input, verifies the final reply, returns to the draft chat, and captures PNGs at 1440×900. It never sends a message. Avoid symlinking tooling/cache directories (`.vite-temp`, `.vite-*`, `.cache`) to another checkout when reusing installed dependencies. Use the default Vite loader: `--configLoader runner` fails the imported web config's `__dirname` usage. Keep `.vite-temp` and fixture cache directories real/local in this worktree, never symlinked into another checkout.

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

## Follow-on profiling — corrected geometry and bounded controls

**Important correction:** early component diagnosis omitted `flex flex-col` on the fixture sidebar. Its unconstrained viewport could load every page. The resulting ~17k DOM / ordinary1,000-session selection scaling is **not evidence of normal production DOM**; retract that ordinary-case ranking strength. Production already pages50 sessions, caps search at100 results, and intentionally keeps a family unsplit. `profile.tsx` now constrains the real ScrollArea correctly. `family=1` creates one deliberately extreme expanded family to test the actual pagination exception. Older raw diagnosis remains preserved, not silently rewritten.

Final list behavior: only >200 **already-paged logical rows** are windowed. All SessionList sizes use one stable keyed row/header boundary so valid open menus/focus survive200↔201. Ordinary lists gain row wrappers/measurement subscriptions (small overhead, disclosed), but no React updates on ordinary scrolling. Other EntityList consumers are unchanged. Keep the logical keyboard/selection/hierarchy model intact; estimates are corrected by measured heights, so offscreen total height is approximate until visited.

Launch the follow-on fixture with installed dependencies and installed Chrome:

```sh
bun node_modules/vite/bin/vite.js --config scripts/fixtures/session-metadata/profile-vite.config.ts
# In another terminal, one browser at a time:
bun scripts/fixtures/session-metadata/profile-browser.ts /absolute/artifacts/equal-before 'count=100&history=1000&richSize=4&shell=0&baselineSharing=1' equal
bun scripts/fixtures/session-metadata/profile-browser.ts /absolute/artifacts/equal-after 'count=100&history=1000&richSize=4&shell=0' equal
bun scripts/fixtures/session-metadata/profile-browser.ts /absolute/artifacts/list-old 'count=1000&history=1000&richSize=4&shell=0&family=1&baselineBoundary=1&baselineWindowing=1' list
bun scripts/fixtures/session-metadata/profile-browser.ts /absolute/artifacts/list-new 'count=1000&history=1000&richSize=4&shell=0&family=1' list
bun scripts/fixtures/session-metadata/profile-browser.ts /absolute/artifacts/window-check 'count=1000&history=1000&richSize=4&shell=0&family=1' window-check
bun scripts/fixtures/session-metadata/profile-browser.ts /absolute/artifacts/bottom-check 'count=1000&history=1000&richSize=4&shell=0&family=1' bottom-check
bun scripts/fixtures/session-metadata/profile-browser.ts /absolute/artifacts/threshold-check 'count=195&history=1000&richSize=4&shell=0&family=1' threshold-check
bun scripts/fixtures/session-metadata/profile-browser.ts /absolute/artifacts/threshold-middle 'count=195&history=1000&richSize=4&shell=0&family=1' threshold-scroll
bun scripts/fixtures/session-metadata/profile-browser.ts /absolute/artifacts/threshold-bottom 'count=195&history=1000&richSize=4&shell=0&family=1' threshold-scroll-bottom
bun scripts/fixtures/session-metadata/profile-browser.ts /absolute/artifacts/action-check 'count=100&history=1000&richSize=4&shell=0&actionProbe=1' action-check
```

`equal` delivers **exactly400 background+40 visible deltas**, with12 typed characters, and saves normalized synthetic transcripts for byte comparison. `list` performs identical warm plain/rich switches and5 meaningful status changes. Remove `family=1` from the list pair to measure ordinary50-row wrapper overhead. No live send/provider/API is used. Branch and menu tests record only synthetic callbacks. Save&Send tests dispatch the existing custom event against a fake composer, never an actual send.

The follow-on server is loopback5190 with no backend proxy. Its **fixture-only Vite transforms** count heavy memoized TurnCard/Markdown renders and group calls, capture retained first-render handlers, expose bounded cache counts, and optionally disable specific improvements:

- `baselineSharing=1`: fresh derived turns, no structural reuse.
- `baselineActions=1`: intentionally bypass the fresh committed-action bridge, to reproduce stale branch/settings/send guards.
- `baselineBoundary=1`: intentionally restore threshold subtree replacement, to reproduce menu loss at200↔201.
- `baselineBoundary=1&baselineWindowing=1`: original all-rows grouped path for the list comparison.

These flags/instrumentation do **not** exist in product source or release builds. `action-probe.tsx` uses actual React Suspense/startTransition to verify that an aborted render cannot publish action context. Stable action bridges revoke removed/unmounted handlers and preserve current model/connection/permission/source/directory settings without re-rendering historical Markdown. `window-check` covers keyboard Home/End, range selection, dynamic subtitle anchoring, width resize, menu-anchor scrolling, hierarchy/group collapse, unread counts, capped search focus and cache pruning. `threshold-check` requires the same actual HTMLElement/open menu and correct action target in both directions. `bottom-check` tests surviving tail-row coordinates after native scroll clamping. `threshold-scroll`/`threshold-scroll-bottom` track the same visible row in both directions. The stale inactive-estimate state is separately unit-regressed: initial200×56px estimates versus cached36px would subtract1060px; refresh the old key order first. The observed Chrome runs already had fully measured inactive layouts and passed both before/after this defensive refresh; do not claim a browser coordinate improvement for that source-race correction.

All timings remain single-host **development component** observations, not INP, paint timestamps, full AppShell/native Electron, backend ACK, live incident root cause, macOS or DMG proof. Switch proxy is selection→target DOM→two rAF; input proxy is CDP request→beforeinput→two rAF. A renderer-thread paced producer can stall; use `equal` for same event counts. React nested status-button and menu `bare=true` development warnings pre-exist the corrections; successful final checks have no uncaught runtime exceptions.
