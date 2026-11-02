# Server startup after an unclean exit

On 2026-11-02, an abandoned desktop broker socket caused repeated startup failures. After that socket was recovered, a second abandoned Android companion admin socket caused the next startup failure. Telegram and Android share this server, so neither could respond. The input journal and device credentials were preserved.

## Protection

`startDesktopRuntime` isolates optional desktop initialization errors: it disposes the failed runtime and starts core chat/messaging without a desktop gateway. Desktop authorization continues to fail closed.

The deployed systemd preflight runs `scripts/desktop/reconcile-stale-sockets.py` as the service user before starting the server. It checks only `~/.craft-agent/desktop-viewer/input.sock` and `~/.craft-agent/companion/admin.sock`. It requires a private owned parent and private owned socket, probes for a listener, requires `ECONNREFUSED`, rechecks inode identity, then moves the abandoned socket to a private backup directory. Active listeners, symlinks, regular files and uncertain failures are never removed. It does not modify device credentials or reset dirty input journals. The service UID and root are trusted; run this as the service preflight, not alongside a separately launched instance.

The installed root-owned helper is `/usr/local/libexec/scoville-reconcile-stale-sockets.py`; `/etc/systemd/system/craft-agents.service.d/15-stale-socket-preflight.conf` contains:

```ini
[Service]
ExecStartPre=/usr/bin/python3 /usr/local/libexec/scoville-reconcile-stale-sockets.py
```

Keep that helper in sync with the repository script when deploying. The service runs as `advait`; no credentials are placed in this drop-in. Failures are visible in the systemd journal. A live listener indicates an existing instance and requires investigation; this preflight never forcibly takes it over.

## Checks

```sh
python3 scripts/desktop/test_reconcile_stale_sockets.py
bun test packages/server/src/desktop-startup.test.ts packages/server/src/desktop-runtime.test.ts
```

Tests cover abandoned socket preservation, refusing live listeners, refusing symlinks/files/public directories, absent paths, and optional desktop startup failure while preserving the occupied path and dirty journal.
