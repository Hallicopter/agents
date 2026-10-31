# Scoville Agents Android guidance

Scope: this directory only. Server facade changes are owned separately; coordinate contract changes rather than editing server/shared code.

- Native Java, Android API 26+, no Gradle or external runtime libraries. Build via `./build-debug.sh`; local JDK/SDK in `/home/advait/android-toolchain`.
- Follow the actual `/api/companion/v1` facade; never add broad WebUI cookie login, raw RPC, embedded admin tokens or filesystem/credential endpoints.
- Pairing codes are single-use/short-lived and never persisted. Only revocable device credentials, encrypted with Android Keystore AES-GCM, may be persisted. Maintain HTTPS/platform verification/no redirects.
- Device scopes: read, create, chat; non-safe chat additionally requires existing-permissions. Server decides final authorization. Never retry mutations automatically.
- Pages are static/inert: JS, bridges, file/content, network, navigation, cookies, permissions, downloads disabled; restrictive CSP precedes authored content. No agent/source action bridge. Keep native text fallback.
- Avoid logs containing payloads. Backups and screenshots disabled. No transcript disk cache.
- Build outputs/debug keystores must not be committed. Standard debug signing is not production signing.
- Run `./test.sh` and `./build-debug.sh` after edits. Report source/JVM/build tests separately from real Android runtime tests; never imply a device test happened without evidence.
- Device-authorized sends queue host-side, never SDK-steer; pending originals remain runtime-only behind a fixed transcript/disk placeholder until final authorized dispatch. Pending mobile messages intentionally do not survive server restart. Do not weaken this fail-closed boundary or imply device revocation cancels an already executing turn.
- Current snapshot polling is not token streaming. Document limitations honestly. No live deployments, restarts, network listener changes or external distribution without explicit approval.

- Display brand is exactly **Scoville Agents**, never Scoville Companion. Preserve upstream Craft Agents attribution and internal `com.craftagents.companion`/API/credential identifiers; no migration.
