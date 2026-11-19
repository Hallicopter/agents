// Run in a synthetic home; exercise host creation, spawn, and restore without sending a prompt.
import assert from 'node:assert/strict'
import { copyFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PiAgent } from '@craft-agent/shared/agent/pi-agent'
import { getSessionFilePath, listSessionsAsync, readSessionHeader, type SessionMetadata } from '@craft-agent/shared/sessions'
import { SessionManager, setSessionPlatform, type createManagedSession } from '../src/sessions/SessionManager'

type Managed = ReturnType<typeof createManagedSession>
type Harness = {
  sessions: Map<string, Managed>
  getOrCreateAgent(session: Managed): Promise<PiAgent>
  ingestWorkspaceSessions(workspace: Managed['workspace'], metadata: SessionMetadata[]): number
}

const root = process.env.CRAFT_CONFIG_DIR!
assert(root === process.env.HOME && root.includes('craft-puck-focus-'))
const workspace = { id: 'ws', slug: 'fixture', name: 'Offline fixture', rootPath: root, createdAt: 1 }
const slug = 'fixture-pi'
const model = 'pi/gpt-6.2-sol'
copyFileSync(join(import.meta.dir, '../../../apps/electron/resources/config-defaults.json'), join(root, 'config-defaults.json'))
writeFileSync(join(root, 'config.json'), JSON.stringify({
  workspaces: [workspace], activeWorkspaceId: workspace.id, activeSessionId: null,
  defaultLlmConnection: slug,
  llmConnections: [{ slug, createdAt: 1, authType: 'api_key', providerType: 'pi', piAuthProvider: 'openai', models: [model], defaultModel: model }],
}))

setSessionPlatform({
  appRootPath: root, resourcesPath: root, appVersion: 'test', isPackaged: false, isDebugMode: false,
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  imageProcessor: {
    async getMetadata() { return null },
    async process() { throw new Error('Unexpected image processing in Puck fixture') },
  },
})

const manager = new SessionManager()
manager.setEventSink(() => {})
const host = manager as unknown as Harness
// The real spawn/automation callbacks call this only after creation and registration.
// Record that boundary, but never start a model turn in the fixture.
const dispatched: string[] = []
manager.sendMessage = async (id) => { dispatched.push(id) }

async function backend(harness: Harness, id: string) {
  const managed = harness.sessions.get(id)
  assert(managed)
  const agent = await harness.getOrCreateAgent(managed)
  assert(agent instanceof PiAgent)
  const { getPiAutoCompactionFocus } = (agent as unknown as {
    config: { getPiAutoCompactionFocus?: () => 'puck' | undefined }
  }).config
  assert(getPiAutoCompactionFocus)
  return { agent, focus: getPiAutoCompactionFocus }
}

const rootPuck = await manager.createSession(workspace.id, { name: 'Root Puck', labels: ['puck'] })
const parent = await backend(host, rootPuck.id)
assert.equal(parent.focus(), 'puck')
assert(parent.agent.onSpawnSession)
const inherited = await parent.agent.onSpawnSession({ prompt: 'offline fixture', name: 'Inherited Puck label' })
const explicit = await parent.agent.onSpawnSession({ prompt: 'offline fixture', name: 'Explicit Puck label', labels: ['puck'] })

const automation = await manager.executePromptAutomation({
  workspaceId: workspace.id, workspaceRootPath: root, prompt: 'offline fixture', labels: ['puck'],
  automationName: 'Fixture automation', waitForCompletion: false,
})
await manager.flushSession(automation.sessionId)
assert.deepEqual(dispatched, [inherited.sessionId, explicit.sessionId, automation.sessionId])

for (const child of [inherited, explicit]) {
  const header = readSessionHeader(getSessionFilePath(root, child.sessionId))
  assert.deepEqual(header?.labels, ['puck'])
  assert.equal(header?.parentSessionId, rootPuck.id)
  assert.equal(header?.triggeredBy, undefined)
}
const inheritedFocus = (await backend(host, inherited.sessionId)).focus()
const explicitFocus = (await backend(host, explicit.sessionId)).focus()
assert.deepEqual({ inheritedFocus, explicitFocus }, { inheritedFocus: undefined, explicitFocus: undefined })

const automationHeader = readSessionHeader(getSessionFilePath(root, automation.sessionId))
assert.deepEqual(automationHeader?.labels, ['puck'])
assert.equal(automationHeader?.parentSessionId, undefined)
assert.equal(automationHeader?.triggeredBy?.automationName, 'Fixture automation')
assert.equal((await backend(host, automation.sessionId)).focus(), undefined)

for (const id of dispatched) await manager.flushSession(id)
await manager.flushSession(rootPuck.id)
const restarted = new SessionManager()
restarted.setEventSink(() => {})
const restored = restarted as unknown as Harness
restored.ingestWorkspaceSessions(workspace, await listSessionsAsync(root))
assert.equal((await backend(restored, rootPuck.id)).focus(), 'puck')
for (const id of [inherited.sessionId, explicit.sessionId, automation.sessionId]) {
  assert.equal((await backend(restored, id)).focus(), undefined, `restored ${id}`)
}

// Opt out on an already-created Pi backend: the same callback sees the new live label list.
await manager.setSessionLabels(rootPuck.id, [])
assert.equal(parent.focus(), undefined)
const optOutHeaders = await listSessionsAsync(root)
const optedOut = new SessionManager() as unknown as Harness
optedOut.ingestWorkspaceSessions(workspace, optOutHeaders)
assert.equal((await backend(optedOut, rootPuck.id)).focus(), undefined)
