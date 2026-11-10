# Messaging gateway

## Telegram progress lifecycle

- `SessionManager.setProcessing` publishes `processing_changed` only on actual turn ownership transitions. Message acceptance, queued arrival, and `user_message:processing` (replay notification) are not execution-start signals. Start Telegram progress-mode native typing from the lifecycle event, before agent setup or silent reasoning, not from inbound routing.
- Other platforms and response modes ignore this lifecycle event. Preserve Telegram's strict final-only output: no status bubbles or intermediate-only fallback.
- Processing-stop cancels typing without clearing the final buffer: final delivery happens at `complete`, which may follow asynchronous cleanup; queued replay can start another turn without a session-level complete. Existing backend activity still supports permission resumption and older event producers. Once lifecycle events are available, activity cannot revive a stopped turn.
- Every typing stop invalidates the timer epoch, including permission/credential/plan waits. A stale callback must check its epoch before touching the current timer. Stop/reset before awaiting terminal message delivery, so slow/failing sends cannot keep typing alive or reset a newer run.
- Processing transitions do not resolve permission prompts; keep them out of the gateway's stale-permission sweep.

## Validation and builds

Run `bun test packages/messaging-gateway` and `bun test packages/server-core/src/sessions/processing-lifecycle.test.ts`. Renderer tests use fake timers; host integration tests gate offline iterators and exercise real queue replay/setup failure.

The gateway and server-core export TypeScript source for the Bun headless host. Electron bundles them into main (`bun run electron:build:main`); standalone distributions copy source (`bun run server:build`). The Pi backend is separate and executes built `packages/pi-agent-server/dist/index.js` in development (packaged as `resources/pi-agent-server/index.js`); if Pi server or its bundled dependencies change, run `bun run server:build:subprocess` before deployment. A source edit alone does not rebuild that subprocess. No Pi server changes are needed for the Telegram lifecycle hook.
