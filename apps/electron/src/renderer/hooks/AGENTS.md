# Workspace metadata hooks

Labels, statuses and views use `useWorkspaceMetadata` with module-stable sources. Subscribe before loading; treat the immediate transport snapshot as part of initial load, not a second fetch. Refresh once per transition to connected (or endpoint change), and retry failures at most three times (1s/2s/4s). Keep the last successful same-workspace data on failure; never write fallback/default config.

Dispose timers and ignore stale responses on workspace switches/unmount. Do not render the previous workspace's data while switching. Routed metadata notifications use the renderer-local workspace ID; server session metadata deliberately retains the remote workspace ID.

The production fixture is `playground/fixtures/mac-regression.html`, exercised by `scripts/qa-mac-regression.mjs`. It uses mock RPC and synthetic data, not a live user or macOS proof. Loader unit tests cover bounded retry and races; routing tests cover local/remote identity; session atom tests cover label assignments without discarding loaded messages.
