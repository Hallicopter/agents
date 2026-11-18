// Run with a throwaway HOME and CRAFT_CONFIG_DIR. No transport or inference process starts.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import React from 'react'
import { RPC_CHANNELS as R } from '@craft-agent/shared/protocol'
import { getCredentialManager } from '@craft-agent/shared/credentials'
import { getMiniModel, getSummarizationModel, sessionPickerModels } from '@craft-agent/shared/config'
import { registerSettingsHandlers } from '../src/handlers/rpc/settings'
import { registerLlmConnectionsHandlers } from '../src/handlers/rpc/llm-connections'
import { createManagedSession, SessionManager } from '../src/sessions/SessionManager'

const home = process.env.HOME!
assert(home === process.env.CRAFT_CONFIG_DIR && home.includes('craft-ultra-fixture-'))
const slug = 'fixture', standard = 'pi/gpt-6.2-sol', ultra = `${standard}-ultrafast`
const conn = { slug, createdAt: 1, authType: 'oauth', providerType: 'pi', piAuthProvider: 'openai-codex', models: ['pi/gpt-6.2-astra', standard], defaultModel: standard }
writeFileSync(join(home, 'config.json'), JSON.stringify({ workspaces: [], llmConnections: [conn] }))
const sm = new SessionManager(), session = createManagedSession({ id: 's', name: 'fixture' }, { id: 'w', name: 'fixture', rootPath: home, createdAt: 1 } as any)
;(sm as any).sessions.set(session.id, session)
sm.setEventSink(() => {})
const routes = new Map(), server = { handle: (key: string, fn: Function) => routes.set(key, fn) } as any
const deps = { sessionManager: sm, platform: { logger: { info() {}, warn() {}, error() {} } } } as any
registerSettingsHandlers(server, deps); registerLlmConnectionsHandlers(server, deps)
const rpc = (key: string, ...args: unknown[]) => routes.get(key)({}, ...args)
const status = async () => JSON.parse(JSON.stringify((await rpc(R.llmConnections.LIST_WITH_STATUS))[0]))
assert.deepEqual((await status()).models, conn.models)
await getCredentialManager().setLlmOAuth(slug, { accessToken: 'synthetic' })
const dto = await status(), models = dto.models
assert.deepEqual(models.map((m: any) => m.id ?? m), [...conn.models, ultra])
assert.deepEqual(sessionPickerModels(models, dto), models)
assert.deepEqual(sessionPickerModels(conn.models, dto), models)
for (const change of [{ customEndpoint: {} }, { baseUrl: 'https://example.invalid' }, { authType: 'api_key' }, { providerType: 'pi_compat' }, { isAuthenticated: false }, { piAuthProvider: 'openai' }]) {
  assert.deepEqual(sessionPickerModels(models, { ...dto, ...change }), conn.models)
}
assert.equal(getMiniModel(dto), standard); assert.equal(getSummarizationModel(dto), standard)
assert.equal(getMiniModel({ ...dto, models: [ultra] }), undefined)
assert.deepEqual((await rpc(R.llmConnections.LIST))[0].models, conn.models)
assert.deepEqual((await rpc(R.llmConnections.GET, slug)).models, conn.models)
assert.equal((await rpc(R.llmConnections.SAVE, { ...conn, models, defaultModel: ultra })).success, false)
assert.equal((await rpc(R.settings.SETUP_LLM_CONNECTION, { slug, defaultModel: ultra })).success, false)
await assert.rejects(rpc(R.workspace.SETTINGS_UPDATE, 'w', 'model', ultra), /session-only/)
assert.equal((await rpc(R.llmConnections.SAVE, { ...conn, models })).success, true)
assert.deepEqual((await rpc(R.llmConnections.GET, slug)).models, conn.models)
assert.equal(session.ultraGrant, undefined)
const inherited = createManagedSession({ id: 'automatic', name: 'automatic', model: ultra }, session.workspace)
;(sm as any).sessions.set(inherited.id, inherited)
await assert.rejects(sm.sendMessage(inherited.id, 'automatic', undefined, undefined, { hidden: true }), /Select Ultrafast/)
assert.equal(inherited.ultraGrant, undefined)

// Load the complete historical TSX unchanged; stub only styling, translation and other imports.
// React produces the actual row element tree, including the original onSelect closures.
const compile = (src: string) => ts.transpileModule(src, { compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const stubs = new Proxy({ THINKING_LEVELS: [], useTranslation: () => ({ t: (s: string) => s }), cn: () => '', isCompatProvider: () => false, getModelShortName: String, stripPiPrefixForDisplay: String } as any, { get: (o,k) => k in o ? o[k] : String(k) })
for (const rev of ['b1a5d0b3742aa35b8551fa828c92cab2d89692cd', 'd311e9de9ba7da08e314844cceaf3e9f3561398b']) {
  const read = (path: string) => execFileSync('git', ['show', `${rev}:apps/electron/src/renderer/${path}`], { encoding: 'utf8', cwd: join(import.meta.dir, '../../..') })
  const startup = read('App.tsx').match(/window\.electronAPI\.listLlmConnectionsWithStatus\(\)\.then\(\(connections\) => \{[\s\S]*?\n    \}\)/)?.[0]
  assert(startup)
  let hydrated: any
  await new Function('window', 'setLlmConnections', 'setDefaultLlmConnectionSlug', 'resolveDefaultConnectionSlug',
    'return ' + compile(startup))({ electronAPI: { listLlmConnectionsWithStatus: async () => [await status()] } },
    (rows: any[]) => { hydrated = rows[0] }, () => {}, () => slug)
  assert.deepEqual(hydrated, dto)
  const exports: any = {}
  new Function('require', 'exports', compile(read('components/app-shell/input/ComposerModelMenu.tsx')))((id: string) => id === 'react' ? React : stubs, exports)
  const chat = read('pages/ChatPage.tsx'), start = chat.indexOf('  const handleModelChange = React.useCallback'), end = chat.indexOf('}, [sessionId, activeWorkspaceId])', start)
  assert(start >= 0 && end > start)
  let pending: Promise<void> | undefined
  const calls: unknown[][] = []
  const onModelChange = new Function('React', 'window', 'sessionId', 'activeWorkspaceId', compile(chat.slice(start, end + '}, [sessionId, activeWorkspaceId])'.length)) + '\nreturn handleModelChange')({ useCallback: (f: Function) => f }, { electronAPI: { setSessionModel: (...args: unknown[]) => { calls.push(args); return pending = rpc(R.sessions.SET_MODEL, ...args) } } }, 's', 'w')
  for (const pickerMode of ['flat', 'switcher']) {
    await rpc(R.sessions.SET_MODEL, 's', 'w', standard, slug)
    const tree = exports.ComposerModelMenu({ pickerMode, effectiveConnection: slug, llmConnections: [hydrated], availableModels: hydrated.models, connectionsByProvider: [['Pi', [hydrated]]], effectiveConnectionDetails: hydrated, contextDisplay: {}, contextLabels: {}, onModelChange })
    const rows: any[] = []
    function walk(node: any): void { if (Array.isArray(node)) return node.forEach(walk); if (node?.key === ultra) rows.push(node); if (node?.props) walk(node.props.children) }
    walk(tree); assert.equal(rows.length, 1); assert(JSON.stringify(rows[0]).includes('GPT-6.2-SOUL Ultrafast'))
    assert.equal(session.ultraGrant, undefined); rows[0].props.onSelect(); await pending
    assert.deepEqual(calls.at(-1), ['s', 'w', ultra, slug]); assert.equal(session.ultraGrant?.slug, slug); assert.equal(session.model, ultra)
  }
}
process.exit(0)
