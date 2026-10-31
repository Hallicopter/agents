# Install and update Scoville Agents

Scoville downloads belong to [Hallicopter/agents Releases](https://github.com/Hallicopter/agents/releases), not the upstream Craft download site. The release workflow supports downloadable previews now and signed releases once Apple signing credentials are available. Previews use ad-hoc signing, not an Apple-verified Developer ID, and require manual updates.

## Install on your M1 Mac

1. Quit the development app and any running Craft/Scoville instance.
2. Download **Scoville-Agents-arm64.dmg** from the fork's Releases page.
3. Open the DMG and drag **Scoville Agents** to **Applications**, replacing the previous Scoville app if prompted.
4. Open Scoville Agents from Applications. For a preview, if macOS says the developer cannot be verified, use its per-app **System Settings → Privacy & Security → Open Anyway** approval after checking that the download came from this fork ([Apple instructions](https://support.apple.com/en-us/102445)). Keep using the existing remote server connection; the client no longer needs Git, Bun, or localhost:5173.

Existing runtime/configuration identifiers are retained to preserve local state. Do not run Craft and Scoville concurrently. The first transition from Craft or a development build requires installing this DMG manually; the upstream updater cannot install our fork for you.

## Update

For previews, download the newer DMG from the fork’s Releases page and replace the app in Applications. Chats and settings remain outside the app bundle.

Once signed releases are available, use **Check for Updates** in the application menu. Packaged Scoville builds use only this fork's GitHub Releases. When the update is downloaded, choose the install/restart action. You can also replace the app using a newer DMG from the same page. A source push to main is not an app release, and updating the remote server does not update the installed Mac client.

## Maintainer setup

Configure these GitHub Actions repository secrets (never commit or paste their values into an issue):

- `CSC_LINK`: base64-encoded exported Developer ID Application certificate (.p12), including its private key.
- `CSC_KEY_PASSWORD`: password protecting that export.
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`: notarization credentials for the signing team.

See [electron-builder signing](https://www.electron.build/code-signing-mac.html) and [notarization](https://www.electron.build/v26/docs/mac/). Keep the signing identity consistent across releases for macOS update validation.

Run **Scoville Mac release** manually to check packaging. Enable `publish_preview` to publish the ad-hoc signed DMG as a GitHub prerelease with checksums; leave it off to retain workflow artifacts only. For a release, set a higher `apps/electron/package.json` version, commit it to main, and push the matching `vVERSION` tag. The workflow checks the tag/version, builds on an Apple Silicon Mac, verifies the app signature, Gatekeeper assessment and stapled notarization ticket, then publishes the DMG, ZIP, blockmaps and `latest-mac.yml` together. Missing signing secrets or failed verification stop publication. Only Apple Silicon is currently released; Intel/Windows/Linux artifacts are not supplied by this workflow.

Desktop viewing still requires the remote server's explicit session entitlement. A packaged renderer uses a file origin: the workflow verifies `file://` for both the renderer and WebSocket. Configure `electronOrigin: "file://"` in the private desktop deployment, in addition to any development `rpcOrigin`. Never broaden origins to a wildcard.
