# Current deployment and release status — 2026-10-31

The user approved the production cutover. The existing server now runs the fork with the installed broker-aware CUA proxy and input-drain helper. The desktop/container/browser was not restarted. Actual 1440×900 viewing and control succeeded, including a held Shift release on disconnect, denial of agent input during control, and agent resumption after confirmed release. The actual noVNC UI also entered Control and rendered the live framebuffer. These checks do not establish Mac installer signing or client-specific compatibility.

The viewer now shows the mode controls and, during Control, its countdown without explanatory footer boilerplate. A bounded server-relative duration avoids rejecting valid control solely because the client clock differs. The server continues to enforce the absolute deadline. Control remains explicit and limited to configured session entitlements. Set `expiresAt: null` for persistent access without calendar renewal, or use an ISO timestamp for temporary access. Missing or invalid expiry denies access. Each Control connection still lasts at most five minutes; click Control again to start another. Session revocation and deletion still remove access.

The updater now targets Hallicopter/agents GitHub Releases. See [install and release setup](scoville-releases.md); a signed Mac release is pending credentials. Historical sections below describe earlier implementation stages and are superseded by this status, including their statements about pending deployment approval and the unchanged upstream update feed.

---

# Scoville Agents — bounded Desktop viewer fork

## 31 October integration status

The native Electron window and WebUI pop-out are implemented with explicit View only/Control states, capability discovery, scope isolation, bounded control expiry, and immediate input disable on disconnect. Legacy watch-only servers do not advertise Control. The bounded workspace watcher no longer descends into arbitrary browser profiles or session artifacts; this fixes the diagnostic-browser socket crash loop.

The optional control transport now has a shared input arbiter, Unix broker, agent client, persistent dirty-state quarantine, held-input tracking, same-connection RFB Fence handling, and a mandatory host drain callback. `packages/server/src/desktop-control-runtime.ts` wires host configuration when `control` is explicitly present. It checks cooperative ownership and rejects unregistered legacy proxy processes. **Production control is not enabled by this commit.** Socket fixture tests establish transport/release behavior, not live desktop handoff correctness. Direct VNC clients remain outside the broker; this is not a global lock against arbitrary local processes or direct VNC users.

### Proposed production cutover (approval pending)

1. Preserve the installed CUA proxy, deployment JSON, and application revision; never reset the revocation or dirty-state journals during rollback.
2. Build `packages/server-core/src/desktop/cua-broker-client.ts` with Bun (`--target=node --format=esm`) into a root-owned `/usr/local/libexec/scoville-cua-broker-client.mjs`. Apply the reviewed `scripts/desktop/cua-proxy.patch` to `/usr/local/libexec/cua-container-structured-proxy.mjs`. The proposal has been dry-run only. Agent calls then require a live broker; unavailable/uncertain input fails closed rather than bypassing it.
3. Install the fixed `scripts/desktop/input-drain.sh` root-owned as `/usr/local/libexec/scoville-desktop-input-drain`. It runs only a bounded XOpenDisplay→XSync→XCloseDisplay roundtrip on the existing container/display, without input, cookie/profile reads, or desktop restart. Its read-only auth probe succeeded. Establish exact installed-server ordering and live handoff evidence before enabling Control; a generic XSync success alone does not prove pointer-release ordering.
4. In the existing private desktop deployment directory, preprovision a private `input-journal.json` with `{ "version": 1, "dirty": false }` only after proving no outstanding input. Configure `control` with absolute `socketPath`, `journalPath`, `ownerFile`, `proxyPath`, and `drainHelper`. Socket and journal must share the private directory. Use the existing cooperative owner file; never clear someone else's ownership. Add `control:true` only to the already-authorized Jolokia workspace/session entitlement, with an explicit bounded expiration.
5. Coordinate a Craft server restart and drain old unbrokered proxies. Do not restart the desktop/container/browser. Verify old proxies cannot issue input, test a harmless actual takeover/release, check held-key/button cleanup and agent resumption, then verify view-only mode again. Any ambiguous release quarantines agent input; do not clear a dirty journal merely to restore availability.
6. Roll back by disabling the optional control configuration and restoring the saved proxy only after proving no outstanding human input; retain the current revocation/dirty journals. A crash may leave the private broker socket behind: investigate ownership before removing it, never blindly delete an existing socket.

Approval review blocked the live-proxy cutover; repository preparation and synthetic validation continued. This section supersedes historical progress/approval statements below, which record the earlier watch-only implementation.


## What is implemented (and what is not)

The shared Electron/WebUI top bar **+ → Desktop · watch only** opens a bundled noVNC panel. `desktop:grant` uses the existing authenticated workspace RPC/preload adapter; only a single-use viewer grant and public WSS route reach the renderer, never an admin bearer or VNC password. The gateway is injectable into the existing `WsRpcServer`/headless bootstrap and optional WebUI HTTP handler. **It is absent from live startup/configuration by default.** Unconfigured clients show unavailable; desktop HTTP/upgrade routes fail closed.

Actual noVNC 1.5.0 has rendered a framebuffer through the gateway using an isolated localhost TLS + VNC-auth fixture. Electron and WebUI renderer builds and their full typechecks passed during implementation. This is **not live desktop validation, a shipped macOS app, or deployment readiness**. No service, firewall, live config, desktop/profile or CUA tools were changed. No new public listener exists. Existing CUA tools/skills remain unchanged; no input arbitration/takeover was introduced.

noVNC is pinned to 1.5.0 because npm 1.6.0's CommonJS `lib/util/browser.js` contains top-level await and fails the current bundler. MPL-2.0 dependency license remains with the installed library; normal third-party notice obligations apply to distribution.

## Security boundary

- Fixed operator-supplied literal IPv4 endpoint: `127.0.0.1` (existing SSH tunnel/host-local VNC) or `100.64.0.0/10` (private tailnet). No renderer host, URL, DNS resolution, credentials or port selection; no generic proxy/SSRF route.
- Upstream dialect deliberately narrow: **RFB 3.8, VNC Authentication security type 2**, ASCII password 1–8 characters fetched server-side through a callback. No fallback to unauthenticated upstream, older protocol, plaintext password login or other security types. VNC authentication is not encryption: transport must remain inside the existing trusted tailnet/SSH boundary.
- Downstream HTTPS origin is explicit, canonical and exact. TLS is required; `trustedTlsIngress` is an explicit operator assertion for the existing reverse proxy, never inferred from client-controlled forwarded headers. Optional exact Electron file origin (`null` or `file://`) must be verified for the packaged client and configured explicitly; there is no wildcard Origin.
- RPC grant identity derives from authenticated `RequestContext.workspaceId`, not a renderer workspace argument. `authorizeRpc` must separately check the workspace's desktop entitlement, session existence/membership and current permission to watch. Existing generic login by itself is insufficient. No callback means deny.
- Grants expire after 30 seconds, are single-use, and are sent only in the first WebSocket message (not URL, query, subprotocol, storage or logs). Grant expiry is rechecked after async authorization. Grants are bound to expected Origin and a still-connected RPC client/workspace. At most 16 outstanding grants and two pending/active sockets.
- Initial socket authorization has a 5-second termination deadline. Every entitlement callback is bounded to 2 seconds. Active checks run each second: denial/error/hang destroys upstream and closes viewing (up to approximately 3 seconds for polling + timeout). Explicit `revoke(scope)` immediately terminates matching viewers and outstanding grants. Host session-stop/deletion/authorization events **must call revoke**; reconnect never silently grants access. Maximum stream lifetime 5 minutes, requiring explicit reopen.
- Gateway terminates upstream authentication, advertises downstream None only *after* grant and upstream authentication, and requires **shared ClientInit=1**. It cannot evict an existing desktop user via exclusive ClientInit.
- Stateful client parser handles fragmentation/coalescing, forwards only validated SetPixelFormat and FramebufferUpdateRequest, rewrites SetEncodings to Raw only, rejects keyboard/pointer/clipboard/resize/file-transfer/extensions and unknown message types. Failed parsers remain failed. noVNC `viewOnly` is only UX, not enforcement.
- Return-path parser strips ServerCutText (clipboard contents), bounds/drops unsupported messages and encodings. Whole Raw framebuffer update limit is **16 MiB**, at most 128 rectangles; oversized updates fail closed. Typical 1920×1080/1200 fits; **4K full-frame 32-bit updates do not**. Upstream advertised dimension cap of 8192 is an invalid-input bound, not a supported-resolution promise. Raw encoding uses more bandwidth than compressed VNC; keep this bounded MVP private.
- Client queue 64 KiB, WS buffered output limit 4 MiB, 10-second RFB handshake deadline. Closing the viewer destroys only its TCP connection, not the desktop/container/profile.

## Existing desktop hookup — requires separate approval

Ops provided documentation-only metadata: existing VNC is `vps.sturgeon-dab.ts.net:5902`, with an SSH tunnel alternative targeting host `127.0.0.1:5902` (documented local port 15902). Its RFB version/security type/native TLS are **unverified**. Root-only password must not be retrieved into chat, renderer or logs. Do not restart or probe while LinkedIn recovery owns the desktop. Do not create another desktop/container/browser profile; the intended target is the existing shared dedicated rootless Podman desktop and signed-in state.

After approval, an operator must:

1. Coordinate a non-disruptive version/security compatibility check with the desktop owner. If not RFB3.8 + type2 or password policy differs, **stop**; add/review the required protocol support instead of weakening checks.
2. Choose the fixed existing protected route. For a server on the VPS, the already-existing loopback route can avoid another listener. For another host, obtain the operator-confirmed tailnet IP or approved existing SSH tunnel. This code never starts tunnels/services or changes network exposure.
3. Construct **one** `DesktopGateway` in the host startup and pass that same instance as `desktopGateway` to `bootstrapServer(...)` (or `WsRpcServer`) and, if HTTP grant endpoint is used, `createWebuiHandler(...)`. Export is `@craft-agent/server-core/desktop`. Do not create a second public HTTP/WS server.
4. Supply server-side password reader from the approved secret mechanism; explicit HTTPS public origin; verified Electron opaque/file Origin; and `authorizeRpc(context, scope)` backed by real session/workspace lookup plus an explicit approved desktop entitlement. The current `ISessionManager.getSession(id)` is available for membership lookup, but mere existence is not sufficient authorization. Maintain a revoked-session set/generation; reject stopped/deleted/revoked sessions. If HTTP grants are enabled, `authorize(headers, scope)` must independently validate auth and entitlement. It may simply return false when using only RPC grants.
5. Wire session stop/deletion/authorization removal to `gateway.revoke({workspaceId,sessionId})`. Polling checks are defense-in-depth, not a replacement for explicit revocation wiring. Auth callbacks must reject disconnected/revoked identity and must not re-enable a stopped session merely because it still exists on disk.
6. Route `/api/desktop/view` over the **same existing authenticated ingress**, preserve Origin, support WebSocket upgrades, and apply ingress request/connection rate limits. Only set `trustedTlsIngress:true` when that listener is reachable solely through the approved TLS terminator/private path. No new public VNC port, no raw password in URLs, no secret-bearing access logs.
7. Build/review server + client; separately approve live deployment/restart. Test on the existing desktop: profile unchanged, watch-only key/pointer/clipboard denied, concurrent CUA work unaffected, stop/revoke/disconnect closes viewer, and wrong workspace/session/Origin denied. M1 packaged Electron Origin must be verified rather than assumed.

Until these steps are completed, the panel correctly remains **unavailable**. Configuration/entitlement wiring is deliberately not guessed or enabled by this branch.

## Validation and reproducible fixture

From repository root (no live credentials needed):

```sh
bun install --frozen-lockfile --ignore-scripts
bun test packages/server-core/src/desktop/desktop.test.ts packages/shared/src/protocol/__tests__/routing.test.ts packages/server-core/src/transport/__tests__/server-lifecycle.test.ts
./node_modules/.bin/tsc --noEmit -p packages/server-core/tsconfig.json
./node_modules/.bin/tsc --noEmit -p apps/electron/tsconfig.json
./node_modules/.bin/tsc --noEmit -p apps/webui/tsconfig.json
bun run --cwd apps/electron build:renderer
bun run --cwd apps/webui build
bun packages/server-core/src/desktop/browser-fixture.ts /absolute/test-artifact-directory
```

Browser fixture requires local `google-chrome` and `openssl`. It binds disposable servers/debugging on **127.0.0.1 only**, creates a temporary browser profile/self-signed certificate, verifies an actual noVNC canvas pixel and writes `desktop-fixture.png`, `desktop-fixture.html`, `result.json`; then closes listeners/browser and removes only its temporary files. Certificate-check bypass and no-sandbox flags are restricted to this isolated test process, **never production installation advice**. Screenshot is explicitly labeled fixture, not the user's desktop. It validates actual noVNC/gateway compatibility, not macOS Electron signing, deployment authorization or the live VNC dialect.


## Minimal visible rename (final scope)

The packaged macOS application/DMG/ZIP is labeled **Scoville Agents** (`Scoville Agents.app`, `Scoville-Agents-arm64.dmg`, `Scoville-Agents-arm64.zip`); window/menu/HTML titles use the same display label. Upstream LICENSE, NOTICE, copyright/author attribution and internal identifiers remain intact.

**No bundle ID, protocol, configuration directory, credential backend, userData path or updater behavior was changed.** To avoid an implicit path change from `productName`, builder `extraMetadata.productName` explicitly retains `Craft Agents`: Electron39.2.7 `lib/browser/init.ts` selects package.productName before loading main, and default userData is appData + runtime name. Existing `app.setName(process.env.CRAFT_APP_NAME || 'Craft Agents')` remains untouched. Display conversion maps only the default runtime name to Scoville and preserves custom/dev names. Tests assert old/new default-path computation equivalence and unchanged bundle/feed; no guessed path is pinned, no files are moved/copied and no migration occurs.

The inspected credential manager uses an encrypted file under CONFIG_DIR rather than an OS-Keychain backend. It is unchanged. Treat official and fork as sharing the same local state/identity: never launch both concurrently. macOS signing/trust validation on the M1 artifact remains outstanding. A simple visible rename does **not** make updater releases fork-specific.

References: Electron39.2.7 [bootstrap source](https://github.com/electron/electron/blob/v39.2.7/lib/browser/init.ts); [app.getPath documentation](https://www.electronjs.org/docs/latest/api/app#appgetpathname).

## M1 Mac installation and fork updates — audited implementation

Confirmed user target: **macOS Apple Silicon/M1, arm64**. No DMG/app/ZIP was produced here (Linux worker). Do not install x64 or promise a universal binary: current builder defines separate arm64/x64 targets, not universal.

### What the current updater actually does

- `apps/electron/electron-builder.yml`: app ID `com.lukilabs.craft-agent`, visible product `Scoville Agents`, retained runtime package productName `Craft Agents`, `publish.provider: generic`, feed **https://thecraftagents.com/electron/latest**.
- `apps/electron/src/main/auto-update.ts`: `electron-updater`, automatic download enabled and install-on-quit enabled; `checkForUpdates()` reads packaged updater configuration. There is no fork GitHub `setFeedURL` override. Mac update payload is ZIP; DMG is for initial/manual install. Update install uses `quitAndInstall(false,true)` with existing shutdown hooks.
- Consequently, publishing a GitHub release in `Hallicopter/agents` **does not update the official app or this unmodified fork feed**. Installing a fork built with the current feed risks being updated back to official code. Feed isolation is a prerequisite, not a post-install suggestion.
- `apps/electron/scripts/build-dmg.sh arm64` is the existing full macOS assembly route; outputs `apps/electron/release/Scoville-Agents-arm64.dmg` and `.zip` (builder also generates update metadata). It automatically attempts 1Password secret sync if `op` exists and loads root `.env`; it cleans build folders. **Do not run it casually under no-credentials/no-destructive-work authorization.** No such script was executed here. `--upload`/`--latest` refer to the upstream S3 publishing path and are not the fork route; this checkout's referenced `scripts/upload.ts` is absent.
- Builder config uses hardened runtime and entitlements. Notarization stanza is commented out. Both build helpers set `NOTARIZE=true` when Apple environment fields exist, but that alone is **not evidence of successful notarization**. Verify actual builder behavior/output; do not claim a signed/notarized artifact based on an environment variable.

### Route A — reviewed manual local install (no release publication)

1. On an authorized macOS arm64 build machine, prepare the branch/dependencies/runtime assets with the existing assembly flow, after explicitly reviewing its secret-sync/.env/cleanup behavior. Run the arm64 assembly only in a clean build checkout. Keep publication disabled (`electron-builder --publish never` for the packaging step; never the upstream upload flags).
2. **Acknowledge the unchanged official update feed before installation.** Per the final minimal-rename scope, this branch does not disable or redirect updates. It can therefore auto-download/install an official update and replace fork changes. A durable fork updater/manual-only policy is a separate decision/change, not silently bundled into the name switch.
3. Use an authorized Developer ID Application identity, hardened-runtime entitlements and a validated notarization flow. Verify with `codesign --verify --deep --strict --verbose=2 <app>` and `spctl --assess --type execute --verbose <app>`; validate notarization/stapling with Apple's tooling. If a locally built unsigned artifact is blocked, stop and resolve signing/trust; do not disable Gatekeeper, strip quarantine or turn off certificate checks.
4. Quit the official app; back up local state using the user's approved backup process (do not copy secrets into this branch). Manually install the reviewed arm64 app from the trusted DMG. Official→fork migration is a **one-time manual step**; differing signing identity/bundle ID should not be assumed compatible with automatic in-place updates.
5. This is a **cosmetic rename, not a separate application identity**. Bundle ID, protocol, runtime name, Electron userData and ~/.craft-agent remain unchanged. Quit the official app before launching Scoville; do not run them simultaneously against shared state. No migration/import is performed or required for the existing local configuration. Confirm the existing server/workspace connection, without creating a new CUA desktop/profile. Keep the official installer as the rollback route; back up state before any manual replacement.
6. Subsequent manual updates repeat trusted artifact verification and manual replacement. Code here does not produce or select a signed installer automatically.

### Route B — fork GitHub Releases auto-update (future publication approval)

1. In a separately reviewed fork packaging config, replace the generic official `publish` block with electron-builder's GitHub provider for the actual authorized fork repository (`owner: Hallicopter`, `repo: agents`, appropriate release type). Choose app identity/signing continuity and a monotonically increasing fork version. Review `apps/electron/package.json` and root/version conventions together. This documentation is not publication authorization.
2. Produce signed/notarized **arm64 DMG + ZIP** and matching builder-generated **`latest-mac.yml`** and any generated blockmaps. Keep manifest artifact names, SHA512/size and version consistent. A DMG alone is not the updater payload. Build first with `--publish never`; inspect the packaged `app-update.yml` to confirm the fork provider/feed before initial install.
3. After explicit approval, publish those exact artifacts to a matching GitHub release/tag using the fork's release credentials in CI, never renderer/client credentials. Public and private repository update access differ: **do not embed a GitHub token in the client**. If release assets are private, design an approved authenticated distribution channel before claiming automatic updates work.
4. Manually install the first trusted fork build as in Route A. Future fork updates can then use the configured feed, subject to platform signing/version checks. Verify a controlled arm64 update/rollback exercise on macOS before rollout. Nothing in this branch changes the official installed app's feed.

### Remaining approval/setup blockers

- Live VNC dialect/password compatibility and protected-route confirmation, without disrupting active LinkedIn recovery.
- Explicit desktop entitlement + session revocation integration and exact production/Electron Origin, followed by approved server deployment/restart.
- Mac arm64 build host and signing/notarization identity/process. Any future fork-only update policy requires a separate decision; current official updater remains unchanged.
- Separately approved installer distribution/GitHub release publication. No release, merge, live config or service changes are part of this implementation.

## Headless deployment integration (opt-in follow-up)

`packages/server/src/desktop-runtime.ts` constructs a single gateway only when
`CRAFT_DESKTOP_CONFIG` names an operator-provisioned private JSON file. Both the
file and its containing directory must be private (no group/other access), owned
by root or the service user. Config, secret and revocation journal are opened
with `O_NOFOLLOW` and checked/read on the same fd. Root and the service user are
trusted operators: final-component no-follow does not protect against a trusted
operator replacing ancestors. Do not place configuration beneath an untrusted
writable ancestor.

The JSON contains `origin` (existing HTTPS RPC listener), optional `rpcOrigin`
(one exact renderer origin; HTTP only for literal loopback/localhost),
`upstream: {host,port,passwordFile}`, and `entitlements` entries of
`{workspaceId,sessionId,expiresAt}`. This is RPC-only: HTTP grant authorization
always denies. No default/all-workspace entitlement exists. Each check reads the
current config/journal and verifies real session membership, then rechecks after
asynchronous lookup. Endpoint changes fail closed until reviewed restart.

Provision an empty private `<config-path>.revoked` journal before first startup;
it is never recreated automatically. Stop/delete writes and fsyncs revocation
before calling the original lifecycle method. Journal failure disables viewing
but does not prevent Stop/delete. Revocations survive process restart. File
changes immediately revoke tracked grants/viewers, with periodic checks as
backup. Never restore an older journal during rollback or re-enable a stopped
session merely because it still exists.

Use a narrowly scoped systemd `LoadCredential=desktop-vnc:<existing-root-secret>`
for server-only secret access; do not chmod/chown the original root-only file,
place its content in environment/config/renderer, or log it. A service credential
addition and exact deployment config must be approved and reviewed before use.
This follow-up does not itself establish live deployment or a real desktop frame.

The narrow TigerVNC adapter validates the entire bounded plaintext as printable
ASCII, strips at most one terminal LF/CRLF, rejects empty/embedded newlines or
non-ASCII (including malformed suffixes), then derives the first eight ASCII
bytes used by standard VncAuth DES. The gateway still rejects keys longer than
eight bytes. Neither the raw nor effective credential is logged or persisted.
On 30 October 2026 a transient `LoadCredential` authentication-only check against
the existing loopback5902 succeeded (RFB3.8/type2); it stopped before ClientInit,
framebuffer requests or input. This establishes effective-key compatibility,
not a live viewer frame or desktop UI validation.

### Systemd credential ACL compatibility correction

Production `LoadCredential` on this host uses root-owned0440 files and0550
directories with named-service-user POSIX ACLs; mode group-class bits are the ACL
mask, while group-object permissions are zero. Applying config/journal0600
checks to those files caused the live gateway to close before its ready message.
The separate credential reader now accepts only exact
`CREDENTIALS_DIRECTORY/desktop-vnc`, with the namespace supplied by systemd,
canonical `/run/credentials/<unit>` form, root-owned protected ancestors,
descriptor-anchored no-follow directory/file opens, rootuid/gid0 read-only
0400/0440 files (<=130bytes) and0500/0550 credential directories. This trusts
root/systemd ACL provisioning; mode bits alone do not prove ACL audience.
Config/journal stay strictprivate. No source chmod/chown/ACL change is made.
Run optional root-only synthetic metadata regressions with
`sudo bun test packages/server/src/desktop-credential-root.test.ts`; tests use
only temporary dummy strings under `/run/credentials`, never real secrets.
