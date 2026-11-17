# Explicit per-session OpenAI speed requests

> **Operational blocker — Ultrafast is not verified working.** The single authorized native ChatGPT OAuth preview request sent `gpt-6.2-sol` with `service_tier: ultrafast`, but the provider's HTTPS SSE terminal returned the same model with `service_tier: default`. The feature correctly rejected the mismatch with no fallback/retry. The cause (wire/configuration/rollout/account) remains unknown; this does **not** prove account ineligibility. This branch remains unmerged and undeployed.

## Scope and activation

This feature adds the same speed control to the shared Electron renderer (including macOS) and WebUI composer, in full and compact layouts. It is separate from the catalog-only GPT-6.2 addition on main (`1698f871`). Neither selecting a new model nor installing this feature enables premium speed.

- New, spawned, continued-as-new and forked sessions start **Standard**. Moving a session or resuming the same saved session retains its explicit preference.
- Choose **Requested: Standard/Fast/Ultrafast** beside the model picker. Premium requires the exact consumption/billing warning and a separate confirmation. Cancel/Escape does nothing. Changes are disabled while processing.
- The saved chip changes only after runtime acknowledgement, durable persistence and the canonical session metadata event. It is a **request**, never an entitlement or applied-tier claim.
- Standard can always be explicitly reselected, including when already saved, to recover an uncertain update. Failed/lost runtime acknowledgement or failed rollback blocks sending until successful explicit reselection.
- Incompatible model/connection changes preserve and visibly reject the saved premium request; they never silently downgrade, switch models, switch connections or change billing modes.

## Eligibility and costs (official evidence checked 17 November 2026)

Native `openai-codex` OAuth and native `openai` API connections only; account labels are not evidence of access. Compatible/custom endpoints do not receive these premium options.

The 6.2 launch explicitly lists **Pro $200: 6.2 Sol Ultrafast**, and **Pro $500: Astra and Sol**. The generic pricing page still says $500-only. Because that discrepancy is unresolved, OAuth exposes only the documented $200 subset: 6.2 Sol. This is a conservative request allowlist, not account verification. Native API supports the separately documented 6.2 Astra/Sol, 6 Astra and 6.1 Sol Ultrafast models; existing API billing is explicitly disclosed, never used as an OAuth fallback.

For 6.2 Ultrafast, included ChatGPT allowance is **6× Standard**, while eligible purchased-credit/API token rates are **3× through 28 February 2027**, then **6× from 1 March Pacific time**. These are separate quantities. Monetary token-cost displays are estimates, not verified ChatGPT subscription charges. Cache/long-context charges can also apply. The warning also discloses US-only residency for 6.2 Ultrafast and that **up to 4.5× token generation is not guaranteed task speed**. Fast multipliers and older supported models use their own shared policy; see `packages/shared/src/agent/openai-speed.ts`.

Sources:
- https://learn.chatgpt.com/docs/whats-new/gpt-62-astra-sol
- https://learn.chatgpt.com/docs/agent-configuration/speed
- https://learn.chatgpt.com/docs/pricing?codex-pricing-speed=ultrafast
- https://developers.openai.com/api/docs/guides/ultrafast-mode
- https://developers.openai.com/api/docs/models/gpt-6.2-sol
- https://developers.openai.com/api/docs/models/gpt-6.2-astra

## Request, confirmation and budget boundaries

1. Renderer confirmation → existing session-command RPC → SessionManager transaction → correlated PiAgent/child acknowledgement → durable header verification → canonical metadata event.
2. Native main-chat stream wrapper writes exact `service_tier` at the final `onPayload` hook: Standard=`default`, Fast=`priority`, Ultrafast=`ultrafast`. This survives the installed SDK's `streamSimple` option filtering while preserving native auth/hooks.
3. Only terminal provider-returned `service_tier` confirms application. Missing metadata is explicitly **unverified**. A mismatch produces a visible error, never a model/tier/transport/billing fallback or automatic retry; usage may already have been consumed.
4. Premium disables agent retry, provider retry, automatic compaction/overflow recovery and cache warming. The child cannot re-enable auto-compaction while premium is selected. Premium forces **SSE** because installed Codex WebSocket continuation/connection-limit retries and WS→SSE fallback are independent of retry settings. This deliberately favors one-attempt billing safety; no latency improvement has been benchmarked.
5. Utility `queryLlm` sessions always use a separate fixed-Standard wrapper. Compaction/branch-summary routing IDs differ from the main session and are pinned Standard. Native direct-HTTP search utilities also explicitly request `default`; compatible endpoints remain unchanged. These utilities do not inherit the parent preference.
6. Standard restores existing agent retry/compaction/cache-warming policy and preserves existing transport selection. Normal tool-call continuation stays a main-session request; this feature does not impose a one-call cap on intentionally requested agent work.

## Actual verification and consumed-error accounting

On 17 November 2026, two live WebUI canaries through the existing native ChatGPT OAuth connection produced the requested exact answers on the 6.2 Sol and Astra selections. Each had one composer send, no visible retry/tool events and no browser runtime errors. The deployed catalog baseline does not expose raw terminal provider model/tier: echoed SDK model metadata is not independent provider proof, nor is one UI send proof of one low-level provider attempt under its existing Standard retry policy.

A separate isolated, empty-workspace PR preview then used explicit Ultrafast consent for **one** native Sol request. A test-only observer captured exactly one HTTPS SSE POST with requested `model: gpt-6.2-sol` and `service_tier: ultrafast`; no extra POST or WebSocket occurred. The direct terminal at **2026-11-17T20:40:35.733Z** reported `response.completed`, `model: gpt-6.2-sol`, **`service_tier: default`**, **6714 input / 14 output / 6728 total tokens**. The mismatch was surfaced and the failed answer suppressed. Preview instrumentation was removed and its server stopped. All three authorized requests are spent; no additional request, subscription upgrade, API-key workaround or live deployment is authorized.

The real mismatch exposed a consumed-error accounting defect: the wrapper retained usage but the Pi adapter skipped it on error, leaving canonical session/UI totals at zero. The offline repair captures valid nonnegative finite usage before error/recovery branches and emits it once across normal, retry, compaction-failure and fallback completion paths. Zero synthetic errors cannot erase earlier known usage. Latest input retains context-style semantics; output and estimated cost sum across consumed attempts. Final usage is flushed before completion metadata reads disk; a post-I/O identity/generation guard prevents stale completion from stopping a replacement turn.

For the actual returned **default** tier, the estimated token cost is **$0.013568**, not the requested premium multiplier. This is an estimate, **not a verified subscription charge**. Native context occupancy is a separate snapshot (11000 in the captured preview), not consumed input or total tokens. The sanitized real fixture replays wrapper → adapter → actual SessionManager send/completion → flush → stored header/transcript → fresh DTO. A separately labelled synthetic Ultrafast success is a regression control only, never activation proof. Renderer tests exercise canonical error+complete, requested preference preservation and saved-DTO initialization through real browser reloads on both renderer build configurations; these are offline evidence, not a repeat provider test or native macOS run. The original real preview screenshot predates the repair and correctly remains evidence of the zero-accounting defect, not a corrected live result.

## Independent safety review and regression matrix

All four blocking findings from the independent read-only review were fixed, not deferred:

| Finding | Fix | Offline evidence |
|---|---|---|
| P1: SDK compaction can recover overflow/length independently of retry flag | Disable premium auto-compaction; host startup requests false; child clamps later toggles | Actual SDK AgentSession positive control: Standard overflow really generates compaction summaries and continues the main request. Identical premium overflow generates exactly one main stream and zero summaries. |
| P1: Codex WS continuation/connection-limit retries and SSE fallback ignore maxRetries | Premium forces SSE plus maxRetries=0 | Actual installed Codex SDK with injected 503, 403, missing-continuation and connection-limit failures: one mocked HTTP attempt each, zero WebSocket construction/connections/fallback; no network. |
| P2: Ephemeral query omitted explicit Standard and could honor account premium default | Fixed-Standard utility wrapper; summary routing isolation; native search default | Captured native payloads contain `service_tier: default`; distinct/absent summary routing ID cannot inherit main premium. |
| P2: Rejected premium init could leave host readiness unresolved | Local pre-spawn native-policy validation; rejectable readiness on error/exit/spawn failure | Host error-handshake rejects; unsupported endpoint rejected before spawn/auth. Built bundle emits JSONL error, never ready/auth/provider activity. |

Other coverage: invalid/unacknowledged/busy changes, lost/late ack, swallowed persistence I/O error, rollback failure/send latch, same-session restore and no inheritance, model/Terra/6/6.1 regression, requested-vs-applied accounting, canonical renderer metadata and transport routing. Run the focused speed/runtime tests with:

```sh
bun test packages/pi-agent-server/src/openai-speed.test.ts \
  packages/pi-agent-server/src/bundle-smoke.test.ts \
  packages/shared/src/agent/__tests__/pi-openai-speed.test.ts \
  packages/shared/src/agent/__tests__/pi-event-adapter.test.ts \
  packages/server-core/src/sessions/openai-speed-accounting.test.ts \
  packages/server-core/src/sessions/processing-lifecycle.test.ts \
  packages/server-core/src/sessions/openai-speed.test.ts \
  packages/server-core/src/sessions/openai-speed-backend-init.test.ts \
  apps/electron/src/renderer/lib/__tests__/openai-speed-command.test.ts \
  apps/electron/src/renderer/atoms/__tests__/openai-speed-metadata.test.ts \
  apps/electron/src/renderer/atoms/__tests__/openai-speed-accounting.test.ts \
  apps/electron/src/transport/__tests__/openai-speed-routing.test.ts
```

Browser fixture: `PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs bun apps/webui/tests/openai-speed.browser.mjs /absolute/artifact-directory`. This builds actual shared composer fixtures through both Vite configurations, starts only owned loopback preview servers and blocks nonlocal requests. It does not start Craft services or use provider credentials. See the adjacent renderer `AGENTS.md` for accessibility and requested-state invariants.

## Verification limits / release gate

- The bounded authenticated tests above consumed real usage. Ultrafast application **failed verification** because the provider returned `default`; entitlement, activation cause, latency gain and actual subscription charges remain unverified. Public launch/speed/API documentation does not independently establish that this OAuth endpoint accepts the API tier field on this account. No more provider calls are authorized.
- Linux production Electron-renderer/WebUI builds and browser-rendered parity are not a native macOS app/signing test. Native macOS activation and account acceptance remain manual release checks.
- Shared/Pi/Electron/WebUI/UI typechecks pass. Server-core has seven unrelated desktop type errors also present byte-for-byte on clean catalog baseline `1698f871`; this feature does not fix or conceal them.
- The real returned-default activation blocker remains unresolved. The consumed-error accounting repair is verified offline, not deployed. The installed SDK's unused `summarizeForBugReport` API reuses the main routing ID; if Craft exposes it in future, give it an explicit Standard-purpose route instead of assuming all summaries use distinct IDs.
- This is PR-only: do not merge, deploy, restart a live service or change active sessions without separate authority. Catalog-only deployment authority does not authorize deploying this feature branch.
