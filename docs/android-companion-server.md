# Android companion server (isolated MVP, not deployed)

This implementation is **disabled by default**, lives only on the companion branch, and requires deployment approval. It does not open a new TCP port or change WebUI/WS authentication. Do not use a server admin token in the Android app.

## Activation (operator, after approval only)

Set `CRAFT_COMPANION_ENABLED=true` when starting the standalone server. Companion requests share the existing RPC listener and **require TLS at that listener** (configure its existing cert/key options). Reverse-proxy TLS with a plaintext upstream is deliberately unsupported; `X-Forwarded-Proto` is not trusted. Android requires a publicly trusted certificate; do not disable TLS verification. Existing server deployment/restart is an operator action, not performed by these changes.

State is under `CONFIG_DIR/companion/`: owner-only directory 0700, `devices.json` 0600, `admin.sock` 0600. The socket is local Unix IPC, not network HTTP. Existing socket paths are never unlinked on startup; if a crash leaves one behind, an operator must verify the old process is stopped before manually removing it. One server process owns this store; no multiprocess writers.

## Local administration, no restart for grants/revocations

Run as the server's OS user on its host:

```sh
bun packages/server/src/companion-admin.ts /absolute/CONFIG_DIR/companion/admin.sock mint WORKSPACE_ID --session=SESSION_ID
bun packages/server/src/companion-admin.ts /absolute/CONFIG_DIR/companion/admin.sock mint WORKSPACE_ID --all-sessions --allow-chat --allow-create
bun packages/server/src/companion-admin.ts /absolute/CONFIG_DIR/companion/admin.sock list
bun packages/server/src/companion-admin.ts /absolute/CONFIG_DIR/companion/admin.sock revoke DEVICE_ID
```

Mint requires explicit session IDs, `--all-sessions`, or create capability; there is no implicit all-session grant. `--all-sessions` includes future sessions in that one workspace. `--allow-create` independently permits creation and adds created IDs to this device's allowlist. Default is read-only. `--allow-chat` allows chat with safe/Explore sessions. Sending to any other/unknown permission mode additionally requires `--allow-existing-permissions`. Device-authorized sends are rechecked at actual acceptance and delivery/retry boundaries. Mobile sends skip automatic title/label generation and raw-message preturn suggestion/adaptive-decision hooks, avoiding preauthorization metadata/automation side effects; name mobile sessions explicitly. While a session is busy they remain in the host queue rather than the SDK steering buffer. Pending guarded message text is quarantined from persisted/model-visible history until authorized delivery; pending mobile sends intentionally do not resume after server restart. An already executing turn is not canceled by device revocation.

**Consent:** Chat can invoke tools available to the target session under its existing permissions. It is not a tool-free sandbox. This disclosure is printed by the CLI and stored with the grant. Chat does not change existing modes, grant sources, or approve permission requests. New sessions force `safe`, no initially enabled sources, and no working directory, but retain normal Explore-agent capabilities. Device session grants constrain the HTTP API, **not the downstream agent's own tool capabilities**. Give chat only to trusted devices, especially when accepting existing higher permissions.

Mint returns a 256-bit random `ce_...` code valid for five minutes. Codes are one-use, held as SHA-256 hashes in memory only, and invalidated on restart. Enroll returns a distinct 256-bit `cd_...` device token once. Only its SHA-256 digest is persisted (high-entropy random secrets do not need password KDFs); comparisons use constant-time digest comparison. Credential-store replacement fsyncs the new file before atomic rename and fsyncs the parent directory before acknowledging success. Any persistence failure disables all companion authorization/admin operations in that process; failed revocation is NOT acknowledged and never restores old in-memory authorization. Before restarting after such an error, operators must reconcile the on-disk credential store/revocation (do not assume an unsuccessful revoke persisted). Revocation is immediate for subsequent requests and pending reads are rechecked after awaits; it does not cancel an already executing agent turn. Lost phone: revoke from this socket. Android local disconnect alone does not revoke.

## HTTP contract

Base path `/api/companion/v1`; JSON envelopes:

- Success: `{ "ok": true, "data": ... }`
- Error: `{ "ok": false, "error": { "code": "...", "message": "..." } }`

Native requests only: browser `Origin` requests rejected, no CORS, no cookie authentication. Protected routes require `Authorization: Bearer cd_...`. Never put tokens in URLs. All responses are no-store. Transport rejection (426 HTTPS required, 413 too large, 503 not initialized) can be plain text; clients must tolerate non-JSON failures.

| Method/path | Body | data |
|---|---|---|
| POST `/enroll` | `{code,deviceName}` | `{deviceId,deviceToken,workspaceId,scopes,consent,sessionIds,allSessions}` |
| GET `/sessions` | — | `{sessions:[summary],truncated}` |
| GET `/sessions/:id` | — | `{session:summary,messages:[{id,role,content,timestamp}],truncated}` |
| POST `/sessions` | `{}` or `{name}` | `{session:summary}` (201; create grant) |
| POST `/sessions/:id/messages` | `{text}` | `{accepted:true}` (202; durable user-message acknowledgment) |
| GET `/sessions/:id/subagents` | — | `{sessions:[summary]}` (direct children only, filtered by device scope) |
| GET `/pages` | — | `{pages:[{slug,name,description}],truncated}` |
| GET `/pages/:slug` | — | `{page:{slug,name,description},contentText,contentHtml?}` |

Summary: `id,name,isProcessing,lastMessageAt,permissionMode?,sessionStatus?,parentSessionId?`. Scopes: `read`, `chat`, `create`, `existing-permissions`. IDs and slugs must match conservative path patterns. Errors: 401 unauthorized/invalid_code, 403 forbidden/existing_permissions_required, 404 not_found (including out-of-scope), 429 rate_limited, 400 invalid_request. Unknown methods/routes fail closed; there is no generic RPC forwarding or source/admin/Page-action endpoint.

History is a replacement snapshot, latest 100 user/assistant text messages with 16,000-character/message cap; lists cap at 200. Poll selected detail around every two seconds while generating, stop when backgrounded, back off on errors. No SSE sequence/cursor promises. POST messages are **not idempotent**: do not automatically retry after uncertain delivery; refresh history and ask the user. Request body cap 16 KiB; message text 12,000 characters. Global cap 1,000 requests/minute, enrollment 10/minute, per authenticated device 120/minute; fixed-window in-process limits reset on restart and intentionally ignore untrusted proxy IP headers. Global caps trade resilience against unauthenticated denial-of-service; use an operator-managed edge limiter when deploying.

## Data minimization and limitations

Workspace/session checks precede loading history. Raw DTOs, attachments, tool arguments/results, filesystem paths, credential requests, source configurations, Page data stores/grants and action bridges are not serialized. Text uses best-effort recognizable secret redaction; **arbitrary secrets or confidential business information embedded in user/assistant prose or authored Pages cannot be reliably recognized**. Read consent grants access to that selected content, not a promise of DLP. Page read scope covers all Pages in the enrolled workspace (separate from session allowlists).

Pages include optional parser-filtered static `contentHtml`: active elements/event attributes/navigation URLs removed, restrictive CSP added; inline CSS and raster data images retained. Android must also enforce JS off, no bridges, no network/navigation/file/content access and no authenticated resource loading. HTML source larger than 200,000 characters (or redacted output over 250,000 characters) omits this field and uses native `contentText` fallback. Text fallback removes script/style blocks and tags. No live data snapshot or source actions; interactive charts will not run. This sanitizer uses Bun HTMLRewriter (standalone server runtime), not regex as an execution security boundary. Agent errors represented only as non-assistant error messages are not surfaced in this history projection. No permission approval, cancel, attachments, push, create-subagent or session-mode updates. Subagent listing is read-only. Chat can indirectly exercise existing agent capabilities under the explicit consent described above.

No live services, credentials, or main branch were touched during implementation. Tests use temporary directories and fake domain backends; no model invocations or network listener startup.

## Verification

```sh
bun test packages/server-core/src/companion/companion.test.ts
bun x tsc --noEmit -p packages/server/tsconfig.json
```

Full standalone server typecheck passes using the parent-approved read-only node_modules symlink to the existing installation at `/home/advait/craft-agents-oss/node_modules`; no dependency installation or shared changes. Integration is compile-checked, not exercised against live SessionManager/model/services.

Final isolated verification: 18 tests / 230 assertions pass, full standalone server TypeScript check passes, and `git diff --check` passes. HTTP adapter tests use in-memory streams (no ports). SessionManager integration is verified by signatures/typecheck and inspected durable-ack/queue semantics, not a live model turn.
