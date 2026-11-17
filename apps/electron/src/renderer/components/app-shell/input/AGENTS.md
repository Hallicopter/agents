# Per-conversation OpenAI speed requests

`OpenAISpeedSelector` is mounted once beside the model picker by `FreeFormInput`, shared by Electron and WebUI in full and compact layouts. Keep eligibility/warning rules in the browser-safe direct `@craft-agent/shared/agent/openai-speed` module. Only a native `providerType === 'pi'` connection's `piAuthProvider` is provider evidence; never infer entitlement from connection/account names or offer native tiers on compatible endpoints.

The chip displays **Requested**, never applied/verified. `undefined` means Standard. Never add a premium workspace/new-chat default, localStorage preference, model/connection switch, or optimistic tier update. Premium selection requires the exact shared warning and a separate explicit confirmation with `acknowledged: true`. Await `requestSessionOpenAISpeed`; show structured or rejected errors inline. Only canonical saved `session_metadata_changed` events update `session.openAISpeed`.

Always permit explicit Standard re-request even when the saved field is already Standard: this is the safe recovery path after an uncertain runtime acknowledgment. Incompatible persisted premium requests stay visible with a Standard recovery option, not an automatic downgrade. Disable requests while the session is processing. Keep native radio keyboard behavior, cancel-first focus, focus trapping/restore, live warnings/errors and 44px dialog targets browser-safe.

Tests:
- `bun test apps/electron/src/renderer/lib/__tests__/openai-speed-command.test.ts apps/electron/src/renderer/atoms/__tests__/openai-speed-metadata.test.ts`
- `PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs bun apps/webui/tests/openai-speed.browser.mjs /absolute/artifact-dir` builds both configs and mounts the real composer with synthetic state. It starts only owned loopback preview servers, blocks nonlocal requests, and never starts Craft services or contacts providers. Optional `CHROME_PATH` selects the test browser. This is browser-rendered parity evidence, not native macOS or account-entitlement verification.
