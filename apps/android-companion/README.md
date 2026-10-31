# Scoville Agents — Android MVP

Native Java, Android 8.0+ (API 26), compile/target API 35. No app runtime dependencies or Gradle. Displayed app brand: **Scoville Agents**. Internal package remains `com.craftagents.companion` for compatibility; no application-ID, credential-store, or protocol migration. The artifact filename remains `craft-companion-debug.apk`. This Android fork builds on Craft Agents; upstream attribution, repository LICENSE/NOTICE and internal identifiers remain unchanged.

**Preview only. The server patch is not deployed. This APK has been compiled and signature-verified, but has not been installed/run on an Android device or emulator. Do not treat this as production-ready or runtime-security-certified.**

## What is implemented

- Pair against a user-entered HTTPS **origin** using a five-minute, single-use desktop-issued code; no admin-token login.
- Android Keystore AES-GCM encryption of the revocable device credential plus associated origin/workspace/device/scopes and nonsecret enrollment consent/session-grant metadata. The Pucks screen and Device dialog disclose all-workspace vs initial allowlist count, workspace-wide Pages access and scopes; the Device dialog also shows desktop consent. Older paired records explicitly show that grant details are unavailable. Newly created sessions may expand the grant after this labeled enrollment snapshot. The pairing code is never persisted. Hardware-backed key storage depends on the device.
- Named sessions/Pucks, status, parent links and subagent lists, recent user/assistant history.
- Message existing sessions according to device scopes, preserving that session's existing permissions. `chat` permits safe-mode chat; non-safe sessions also require `existing-permissions`.
- Create a named safe/Explore-mode session with `create` scope. New sessions have no enabled sources and no working directory.
- **Snapshot polling, not token streaming:** current chat every 2 seconds when processing, otherwise lists/chat every 10 seconds. Failed reads back off to 30 seconds. Pausing the Activity stops scheduling reads; an already-started read may finish. No background service.
- Static visual Pages from optional `contentHtml`, with native selectable `contentText` fallback. No live data-store bridge, source actions, scripts, links, external images/fonts, or other interactive capabilities.
- Mobile sends skip automatic title/label generation and raw-message preturn suggestion/adaptive decisions; name sessions explicitly.
- Busy-session mobile sends queue on the server, not in the SDK steering buffer, with authorization rechecked before delivery. Pending mobile sends intentionally do not survive a server restart; check history before manually resending. Revocation does not cancel a turn already executing.
- No automatic POST retry or offline mutation queue. Unconfirmed mutations retain the draft and display an ambiguity warning: inspect history/list before manually trying again.

## Build and tests

Local tooling installed under `/home/advait/android-toolchain`:

- Microsoft OpenJDK 21 from Microsoft's official `https://aka.ms/download-jdk/microsoft-jdk-21-linux-x64.tar.gz`.
- Google SDK command-line tools from `https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip`.
- SDK packages `platforms;android-35`, `build-tools;35.0.0`, `platform-tools` via Google's sdkmanager.
- Python 3 used for ZIP assembly. `curl`, `tar`, `unzip` used for tooling provisioning; no root/system changes.

```sh
cd /home/advait/craft-android-companion/apps/android-companion
./test.sh
./build-debug.sh
```

Overrides: `TOOLCHAIN`, `JAVA_HOME`, `ANDROID_HOME`. No tool downloads occur in the build script. It expects the installed SDK version above. Warnings about Java 8 targets and deprecated framework APIs are currently expected.

Output: `build/craft-companion-debug.apk`; checksum: `build/SHA256SUMS`. Build outputs are gitignored. Standard development signing key is outside git at `$TOOLCHAIN/companion-debug.keystore`, with the conventional debug password. **Debug-signed/debuggable is intentionally not a production security boundary; a developer with authorized ADB access can inspect the process.**

Tests performed:

1. 28 JVM policy assertions: HTTPS origins, unsafe authority/path/query rejection, encoded path segments, read backoff.
2. 38 in-memory HTTPS facade assertions using the actual `Api` class: bearer header, no auth on enrollment, response envelopes, one POST connection, fixed-length request body, redirects, 401/403/429, invalid JSON and response-size bound. No real TLS/socket/server is used.
3. Seven grant-disclosure assertions: absent metadata fallback, initial allowlist count, device-created sessions caveat, all-session grant, workspace-wide Pages and explicit scopes.
4. Manifest/source guardrails: Internet-only permission, backup/cleartext disabled, no permissive TLS override, Keystore AES-GCM, scope gates, static-WebView policy.
5. Java compilation, D8 dexing, APK packaging, zipalign, APK signature v2/v3 verification, `aapt dump badging`.

Fixture tests use **test-only** org.json `20240303` from Maven Central at `$TOOLCHAIN/test-libs/json-20240303.jar`, SHA-256 `3cf6cd6892e32e2b4c1c39e0f52f5248a2f5b37646fdfbb79a66b46b618414ed`. This JAR is not shipped in the APK (Android supplies org.json). If absent, the runner explicitly skips HTTP fixture tests.

## Install and connect (user action; not performed here)

1. Obtain the debug APK locally. Verify its checksum against `build/SHA256SUMS`.
2. On your Android device, permit sideloading for the file-transfer app and open the APK. Alternatively, on your own workstation with your authorized device attached:
   ```sh
   adb install -r craft-companion-debug.apk
   ```
   No distribution, upload, install, or ADB daemon was started by this implementation.
3. **First have the server change separately reviewed and deployed.** The companion facade is off by default. Pairing will not work against an unchanged server.
4. The existing backend listener must actually terminate TLS using a certificate Android trusts. Plain HTTP upstream behind a reverse proxy is currently rejected by the server (426), even if the public edge is HTTPS. Do not work around this with a trust-all client or admin WebSocket token.
5. Use the server worker's desktop/admin instructions to mint a short-lived code with least-privilege session allowlist/scopes. Enter only HTTPS origin, pairing code and device label in the app.
6. To invalidate access, revoke the device on desktop. **Disconnect in this app only erases local credentials; it does not revoke the server credential.**

## Exact API contract

Base path `/api/companion/v1`, Authorization `Bearer <deviceToken>` except enrollment. Success `{ok:true,data:{...}}`; failure `{ok:false,error:{code,message}}`.

| Method | Path | Body / response data |
|---|---|---|
| POST | `/enroll` | `{code,deviceName}` → `{deviceId,deviceToken,workspaceId,scopes}` |
| GET | `/sessions` | `{sessions:[summary],truncated?}` |
| GET | `/sessions/:id` | `{session:summary,messages:[{id,role,content,timestamp}],truncated?}` |
| POST | `/sessions` | `{name?}` → `{session:summary}`; requires `create` |
| POST | `/sessions/:id/messages` | `{text}` → `{accepted:true}` (202); requires `chat`, and `existing-permissions` for non-safe sessions |
| GET | `/sessions/:id/subagents` | `{sessions:[summary],truncated?}` |
| GET | `/pages` | `{pages:[{slug,name,description?}],truncated?}` |
| GET | `/pages/:slug` | `{page:{slug,name,description?},contentText,contentHtml?}` |

Summary fields: `id`, `name`, `isProcessing`, `lastMessageAt`, optional `parentSessionId`, `permissionMode`, `sessionStatus`. Based on the actual scoped facade in `packages/server-core/src/companion/http.ts` and backend adapter in `packages/server/src/companion.ts`; not broad WebUI cookie/WS APIs. The client never grants capabilities beyond returned scopes; server remains authoritative.

## Security boundaries

- HTTPS platform trust/hostname verification, no redirects, no cookies in native API requests, bounded body (2 MiB), connect/read timeouts. No automatic mutation retries.
- Credential bundle encrypted with authenticated AES-GCM under a non-exportable Android Keystore key. No plaintext token in preferences, URLs, logs or app resources. Backup disabled. Screenshot/recents capture blocked using `FLAG_SECURE`; pairing autofill/state saving disabled.
- Transcripts remain in Activity memory, not an offline disk cache. Local drafts do not survive process death, rotation or navigation. No crash/analytics SDK.
- Pages WebView has a synthetic origin unrelated to the authenticated server, receives only authored HTML and **no credentials or JavaScript interface**. JavaScript, DOM/database storage, file/content access, network/image fetches, geolocation, popups, permissions, file picking and downloads disabled. All navigation refused; all non-data subresource requests intercepted. Earliest CSP permits inline styles and data images/fonts only; scripts, connections, frames, forms, objects and workers denied. Later authored CSP cannot relax the existing policy. Text fallback is always available.
- Static rendering is not a guarantee against every Android WebView engine vulnerability or resource-exhaustion document. Real-device hostile-content testing remains required. Keep Android System WebView updated.
- `existing-permissions` allows the **agent** to use its pre-existing tool permissions. It is not a mobile read-only guarantee. The app cannot answer approval/credential requests; resolve them on desktop.

## Remaining limitations / required runtime QA

No real-device/emulator/UI/TLS/Keystore lifecycle/end-to-end server testing was available. Inspect `tests/MANUAL-QA.md` before distributing internally. No attachments, tool output, approvals, push notifications, background jobs, Markdown rich renderer, local search, history pagination or live page data. Server returns bounded snapshots; older/truncated content remains desktop-only. API failures may appear as stable status/code instead of detailed server prose to avoid reflecting sensitive error content.
