# Private watch-only desktop gateway

- Deployment is opt-in: constructor opens no listener, bootstrap defaults to no gateway. Use the existing authenticated ingress only. Never auto-load live VNC credentials or configure a public/raw VNC route.
- `authorizeRpc` must check actual desktop entitlement and session membership/revocation, not just authenticated RPC or workspace ID. Host stop/delete/revoke events call `revoke`; callbacks are bounded and periodically rechecked. No callback means deny.
- Both RFB directions are parsed. Only RFB3.8/type2 upstream auth, shared ClientInit, Raw framebuffer dialect and 32-bit noVNC RGB pixel format are supported. Preserve complete-message buffering, sticky failure, bounds and server clipboard stripping. Client `viewOnly` is never the authorization boundary.
- No keyboard/pointer/clipboard/takeover/CUA integration additions without a separate design review. Viewer disconnect must not stop the existing desktop/container/profile.
- Tests use isolated loopback fixtures only. `browser-fixture.ts` runs actual bundled noVNC via temporary Chrome profile/certificate and emits explicitly labeled test artifacts. Never point it at the live desktop.
- Read `docs/desktop-viewer-fork.md` for security bounds, deployment callbacks, exact M1 build/update caveats and remaining approvals.
