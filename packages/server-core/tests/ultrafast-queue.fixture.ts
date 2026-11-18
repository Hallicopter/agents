// Invoked only by ultrafast-queue.test.ts, in an isolated synthetic home.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSessionFilePath } from '@craft-agent/shared/sessions/storage'
import { getCredentialManager } from '@craft-agent/shared/credentials'
import { SessionManager, createManagedSession } from '../src/sessions/SessionManager'

const root = process.env.CRAFT_CONFIG_DIR!
assert(root === process.env.HOME && root.includes('craft-ultra-fixture-'))
const slug = 'fixture-codex', model = 'pi/gpt-6.2-sol-ultrafast'
const credentials = getCredentialManager()
if (process.argv[2] === 'replace') {
  await credentials.setLlmOAuth(slug, { accessToken: 'same-fixture-token' }); process.exit(0)
}
writeFileSync(join(root, 'config.json'), JSON.stringify({ workspaces: [], llmConnections: [{ slug, createdAt: 1, authType: 'oauth', providerType: 'pi', piAuthProvider: 'openai-codex' }] }))
await credentials.setLlmOAuth(slug, { accessToken: 'same-fixture-token' })
const sm = new SessionManager(), session = createManagedSession({ id: 'offline', name: 'Offline' }, { id: 'ws', name: 'Fixture', rootPath: root, createdAt: 1 } as any, { messagesLoaded: true })
const harness = sm as any
harness.sessions.set(session.id, session)
sm.setEventSink(() => {})
harness.decisionFeatureActive = () => false
await assert.rejects(sm.updateSessionModel(session.id, 'ws', model, slug), /Select Ultrafast/)
await sm.updateSessionModel(session.id, 'ws', model, slug, true)
const selected = session.ultraGrant!
session.isProcessing = true
await sm.sendMessage(session.id, 'queued premium message')
assert.equal(session.messageQueue.length, 1)
const persisted = readFileSync(getSessionFilePath(root, session.id), 'utf8')
for (const secret of [selected.nonce, selected.proof, 'queued premium message']) assert(!persisted.includes(secret))
assert(!JSON.parse(persisted.trim().split('\n').at(-1)!).isQueued)
// Ordinary replacement succeeds from another process, without waiting for approval/exit.
assert.equal(Bun.spawnSync([process.execPath, import.meta.path, 'replace']).exitCode, 0)
await assert.rejects(sm.sendMessage(session.id, 'later'), /selection changed/i)
session.isProcessing = false
let agentCreation = 0
harness.getOrCreateAgent = () => { agentCreation++; throw Error('inference forbidden') }
const failed = Promise.withResolvers<void>()
harness.sendEvent = (event: any) => { if (event.type === 'typed_error' && event.error.code === 'queued_message_replay_failed') failed.resolve() }
harness.onProcessingStopped = () => {}
harness.processNextQueuedMessage(session.id)
await failed.promise
assert.equal(agentCreation, 0)
assert.equal(session.messageQueue.length, 0)
await sm.updateSessionModel(session.id, 'ws', model, slug, true)
assert.notEqual(session.ultraGrant!.revision, selected.revision)
const restored = createManagedSession({ ...JSON.parse(persisted.split('\n')[0]!), ultraGrant: selected }, session.workspace)
harness.sessions.set(session.id, restored)
await assert.rejects(sm.sendMessage(session.id, 'after restart'), /Select Ultrafast/)
process.exit(0)
