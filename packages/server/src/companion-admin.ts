#!/usr/bin/env bun
// Offline client of the running server's owner-only Unix socket; no server token required.
import { companionAdminRequest } from '../../server-core/src/companion/admin'
const [socket, action, value, ...flags] = process.argv.slice(2)
if (!socket || !['mint', 'list', 'revoke'].includes(action ?? '')) {
  console.error('Usage: bun companion-admin.ts /absolute/private/companion/admin.sock mint WORKSPACE [--all-sessions | --session=ID] [--allow-chat] [--allow-create] [--allow-existing-permissions]\n       ... SOCKET list\n       ... SOCKET revoke DEVICE_ID')
  process.exit(1)
}
if (flags.includes('--allow-chat')) console.error('CONSENT: Chat can invoke tools available to target session under its existing permissions. Higher modes require --allow-existing-permissions.')
console.log(await companionAdminRequest(socket, { action, workspaceId: value, deviceId: value, allSessions: flags.includes('--all-sessions'), sessionIds: flags.filter(f => f.startsWith('--session=')).map(f => f.slice(10)), allowChat: flags.includes('--allow-chat'), allowCreate: flags.includes('--allow-create'), allowExistingPermissions: flags.includes('--allow-existing-permissions') }))
