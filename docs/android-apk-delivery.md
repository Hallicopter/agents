# Private Android debug APK delivery

An optional **artifact-only** exception on the existing native-TLS listener serves
`https://vps.sturgeon-dab.ts.net:9100/downloads/scoville-agents-debug.apk`.
Set `CRAFT_ANDROID_APK_PATH` to the operator-staged absolute APK path, then use
the normal reviewed deployment and ops-owned coordinated restart. Without that
setting the listener is unchanged. Do not enable Android backend access until
its independent security review passes; artifact delivery grants no backend access.

The handler reads only a regular non-symlink file, bounded to 33,171 bytes, and
pins SHA-256 to
`38766fa98e3f3dd138f7dc7f6da255e49fc77f2f3dc770253c0920d92c6b2df0`.
It serves validated immutable memory, not a directory or request-selected path.
A different APK needs a separately reviewed hash/size change. Invalid configured
artifacts fail startup closed. GET/HEAD only; query strings and other download
paths are rejected. No redirects, cookies, URL credentials or backend route changes.

Both actual socket endpoints must be in Tailscale address space and native TLS
must be active. Exact canonical Host and port are required. Forwarded headers
are not trusted. **This is tailnet-network scoping, not per-user or per-device ACL
authentication:** any tailnet peer that can reach this listener can fetch this
credential-free debug APK. Keep listener/network ACL restrictions in place.

On the phone, install and connect Tailscale to the authorized tailnet first. Open
the HTTPS link, download the debug APK, and approve Android's install-from-this-
browser permission if prompted. This is a debug-signed sideload, not a Play Store
release. Backend credentials must be paired separately; none are embedded here.

Verification before sharing: native TLS succeeds without certificate bypass;
HEAD has the correct type/length and no body; downloaded GET matches the pinned
SHA-256; POST fails; wrong/query/traversal paths return no APK; login and backend
authentication remain unchanged. Coordinate the live check and restart with ops.

Local exact-artifact tests (artifact is intentionally not committed):

```sh
CRAFT_ANDROID_APK_TEST_PATH=/absolute/path/to/verified.apk \
  bun test ./packages/server/src/android-apk-download.test.ts
```

Without that test variable, startup rejection tests run but positive transport
smoke cases are explicitly skipped. No live listener is used by this test suite.
