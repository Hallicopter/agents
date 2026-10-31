# Runtime QA checklist — NOT YET EXECUTED

Run on API 26 and a current API 35+ device/emulator after backend deployment is explicitly approved. Use synthetic fixture sessions/pages, never live credentials in screenshots/logs. A host-only compile/source test does not verify these properties.

## Installation and lifecycle
- Install debug APK; launch; check keyboard resize, Android 15 edge-to-edge insets, back navigation, large fonts/accessibility labels and touch targets.
- Rotate during pairing, GET and POST; no crash, duplicate POST, stale-screen callback or leaked pairing code. Draft loss on rotation is a documented MVP limitation.
- Background/foreground: no scheduled background polling, foreground resumes; screen/recents protected by FLAG_SECURE.
- Force-stop/reopen: Keystore credential decrypts and reconnects. App data backup does not export credential or pairing code. Uninstall/reinstall requires fresh enrollment.

## Enrollment / authorization
- Valid single-use code succeeds once; reuse/expired/wrong code denied. Enrollment timeout must instruct fresh code rather than retry automatically.
- HTTP, URL password, query token, fragment and path rejected locally.
- Invalid certificate, mismatched host, self-signed certificate rejected; no bypass prompt. Redirects (including same-host) refused; credential never forwarded.
- Device revocation causes 401, stops read retry and disables sending. Device dialog allows local erase/re-pair. Disconnected device must separately be revoked server-side.
- `read` only: no creation/chat; `create` only: creation enabled but no chat; `chat` safe sessions only; `chat` + `existing-permissions`: non-safe chat explicitly allowed and disclosed.
- Device session allowlist/workspace boundary: cannot read or message another workspace/session even using a tampered local client.

## Chat/history/children
- Empty/named/Unicode sessions, processing and idle status, parent link, child list, permitted child navigation.
- Live generation: snapshots update at ~2s; no duplicate bubbles; reading older history preserves scroll; draft remains while snapshots refresh.
- Limits: name <=100 characters, message <=12000; bounded recent history banner present; hidden messages do not appear.
- Wi-Fi loss/recovery, 429 and server unavailable: last snapshot labeled not current, backoff <=30s, no automatic POST retry.
- Drop connection just after server accepts POST: warning explains uncertain outcome, original draft remains; manually inspect history before resending.
- Agent requests approval/credentials: user knows to use desktop; app cannot answer those prompts.

## Pages hostile-content fixtures
- Static inline CSS and data PNG image render, full-document HTML remains legible; selectable text fallback works.
- Attempt script, onerror handler, SVG script, iframe/srcdoc, form POST, meta refresh, external stylesheet/font/image, CSS @import/url, websocket/fetch, file://, content://, intent://, mailto and download links.
- Assert no authored script executes, no navigation starts, no permission/file chooser/download opens, and no outbound resource hits a controlled test endpoint.
- Assert synthetic origin receives no Authorization or server cookie, cannot read credential preferences, no JavaScript bridge exists.
- Pages relying on JS/live data show a static shell or fallback, never a source action.
- Test missing/outdated WebView provider and renderer crash; fallback must remain accessible. Native construction has fallback but renderer-process crash behavior still needs validation.

No screenshots are expected with FLAG_SECURE. Do not remove it from the shipping debug APK simply to capture collateral.
