# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits. The in-app loader only reads `X.Y.Z.md` files, so this file is never shown to users.

## Features

- **Private Desktop watch viewer (opt-in fork)** — Adds an embedded read-only noVNC panel shared by Electron and WebUI, with scoped grants and server-enforced input/clipboard restrictions. Deployment remains disabled until an operator configures the existing private desktop and entitlement/revocation checks.

- **Sign in to MCP servers that reject the OAuth relay** — Some MCP servers only accept a local (loopback) redirect address when signing in, and refuse the Craft Agents relay with an error like "only HTTP loopback callbacks". Add `"oauthRelay": false` to the source's `mcp` block to send the sign-in straight back to the app on `localhost` instead. Leave it unset to keep using the relay. See **Sources → MCP servers → Authentication** in the docs.

## Improvements

- **Desktop in its own window** — Open the existing private desktop in a movable, resizable, minimizable native window, with a scaled full-window display and a WebUI pop-out equivalent. Viewing starts in View only; the simple Control toggle remains unavailable unless the server explicitly supports and confirms it. Closing the window disconnects only the viewer, not the desktop or agent.

- **Scoville Agents display name** — The fork uses a distinct visible macOS app/window/installer name. Bundle ID and data paths remain unchanged; updates come from Hallicopter/agents.

## Bug Fixes

- **Automation docs match what runs** — The automations guide the agent follows, and the automations page on the website, still described the removed `command` action and listed agent events such as `PreToolUse` and `Stop`, which never run actions. The agent could set up automations that silently did nothing. Both now list only the events that trigger automations and document webhook and script actions; scripts are the way to run your own code when an event fires. Fixes [#1117](https://github.com/craft-ai-agents/craft-agents-oss/issues/1117).

- **One broken automation no longer stops the rest** — When a single automation in `automations.json` was invalid (for example one using the removed `command` action, or a typo in a cron expression or regex), the whole file was ignored and none of your automations ran, while the Automations list still showed them all. Now only that automation is skipped: the list marks it **Not running** and its page says why. If the file isn't valid JSON, the list now says so instead of showing nothing, and automations that were already running keep running until it's fixed. The list now also shows script automations, which were missing from it.

- **Automation prompts can't read the app's secrets** — A prompt action expanded any environment variable, so `$CLAUDE_CODE_OAUTH_TOKEN` or `$ANTHROPIC_API_KEY` in a prompt, label or Telegram topic put the real value into the chat. Prompts now expand only the event's `CRAFT_*` variables; anything else, `$HOME` included, expands to nothing. Session names and labels also arrive as they are, without the backslashes that were added before quotes and `$`.

- **Webhook bodies stay valid with quotes in values** — A JSON body broke when a variable's value contained a quote or a line break (for example a session named `Fix "login"`). Values are now inserted as proper JSON strings. A value is also no longer expanded a second time, so a session named `$CRAFT_WH_SLACK_URL` can't pull your webhook secret into a request.

## Breaking Changes
