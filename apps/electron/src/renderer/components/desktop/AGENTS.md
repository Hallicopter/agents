# Embedded Desktop viewer

Shared by Electron and WebUI. Request `desktop:grant` through the existing authenticated workspace RPC/preload API; never expose a server bearer/VNC password, accept arbitrary upstream URLs, or persist grants. The configured WSS URL is server-supplied, path-restricted and credential/query-free. noVNC is bundled/pinned, not fetched from a CDN.

`viewOnly` is UX only: server gateway independently enforces read-only traffic. No clipboard/takeover/keyboard/resize UI. Closing/unmounting/scope change disconnects only this viewer. Timeouts must invalidate pending grants so late RPC results cannot reconnect. Never automatically reconnect after revocation or expiration.

`browser-fixture-client.ts` is only a test bundle entrypoint consumed by the server-side isolated fixture script; it is not imported into the application. Label all fixture artifacts honestly. Production deployment is disabled until explicit entitlement/Origin/upstream configuration is approved; see `docs/desktop-viewer-fork.md`.

Fork branding is cosmetic only: `shared/display-name.ts` provides the Scoville display label, while builder extraMetadata retains the legacy Electron runtime name for identical userData computation. Do not turn a label change into bundle/protocol/config/credential migration or updater changes. The official update feed is unchanged and can overwrite fork changes.
