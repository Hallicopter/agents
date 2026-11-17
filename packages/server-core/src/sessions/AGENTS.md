# Session runtime configuration

## Requested OpenAI speed

- `openAISpeed?: OpenAISpeed` is a **requested**, not provider-verified, tier. Absence means Standard. The shared policy in `@craft-agent/shared/agent/openai-speed` is authoritative.
- Change speed only through async `SessionManager.setSessionOpenAISpeed`. Validate IPC values, premium `acknowledged === true`, native provider/model policy, and manager/backend idle state before applying.
- Await the optional backend setter acknowledgement, then persist and verify the header before emitting `session_metadata_changed` with `changes.openAISpeed`. The normal persistence queue logs IO errors, so a resolved flush alone is not proof of a durable speed change.
- A failed persistence transaction restores previous runtime/managed/header speed. If rollback is uncertain, the runtime-only `openAISpeedError` blocks backend use until an explicit successful speed selection; never auto-downgrade or silently recreate through that latch.
- Sends await `openAISpeedUpdate`. Preserve requested speed through same-session restarts and model/provider changes; the send-path shared policy must reject an incompatible premium request instead of selecting Standard.
- Pass the field in both backend core config and same-session resume config. New sessions, spawned children, continued sessions and forks do **not** inherit paid tiers; a same-session bundle move preserves the request.
- Focused offline coverage: `bun test packages/server-core/src/sessions/openai-speed.test.ts packages/server-core/src/sessions/openai-speed-backend-init.test.ts`. Backend-init capture runs in a separate process to isolate process-global platform registration and stops before auth/postInit/subprocess/provider work.
