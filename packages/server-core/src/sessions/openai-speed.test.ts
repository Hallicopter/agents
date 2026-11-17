import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as backend from '@craft-agent/shared/agent/backend'
import * as config from '@craft-agent/shared/config'
import { createSession as createStoredSession, readSessionHeader, loadSession, sessionPersistenceQueue, type SessionBundle } from '@craft-agent/shared/sessions'
import type { OpenAISpeed, SessionEvent } from '@craft-agent/shared/protocol'
import { SessionManager, createManagedSession } from './SessionManager'
import { spawnedSessionOptions } from './spawn-options'

// No credentials, subprocess or provider calls: the resolver supplies a synthetic native
// OpenAI connection and all live backend operations below are local stubs.
describe('per-session OpenAI requested speed', () => {
  let root: string
  let sm: SessionManager
  let managed: ReturnType<typeof createManagedSession>
  let provider: string
  let providerType: 'pi' | 'pi_compat'
  let resolve: ReturnType<typeof spyOn>
  let events: SessionEvent[]

  const workspace = () => ({ id: 'ws-speed', name: 'Speed tests', rootPath: root, createdAt: 1 })
  const file = () => join(root, 'sessions', 's', 'session.jsonl')
  const internal = () => sm as any

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'session-openai-speed-'))
    sm = new SessionManager()
    events = []
    internal().sendEvent = (event: SessionEvent) => events.push(event)
    managed = createManagedSession({ id: 's', model: 'pi/gpt-6.2-sol' }, workspace() as never, { messagesLoaded: true })
    internal().sessions.set('s', managed)
    provider = 'openai-codex'
    providerType = 'pi'
    resolve = spyOn(backend, 'resolveBackendContext').mockImplementation(args => ({
      connection: { slug: 'offline', providerType, piAuthProvider: provider, authType: 'oauth', defaultModel: 'pi/gpt-6.2-sol' },
      provider: 'pi',
      authType: 'oauth',
      resolvedModel: args.managedModel ?? 'pi/gpt-6.2-sol',
      capabilities: { needsHttpPoolServer: false },
    } as never))
  })

  afterEach(async () => {
    await sessionPersistenceQueue.flush('s')
    resolve.mockRestore()
    rmSync(root, { recursive: true, force: true })
  })

  it('leaves existing session model/thinking defaults unchanged and defaults to Standard', async () => {
    managed.model = 'pi/gpt-6.1-sol'
    managed.thinkingLevel = 'high'
    expect(sm.getSessions()[0]?.openAISpeed).toBeUndefined()
    await sm.setSessionOpenAISpeed('s', 'standard')
    expect(managed.model).toBe('pi/gpt-6.1-sol')
    expect(managed.thinkingLevel).toBe('high')
    expect(readSessionHeader(file())?.openAISpeed).toBe('standard')
  })

  it('persists acknowledged premium to the header, full session and list/detail DTOs across restore', async () => {
    await sm.setSessionOpenAISpeed('s', 'ultrafast', true)
    const header = readSessionHeader(file())!
    expect(header.openAISpeed).toBe('ultrafast')
    expect(loadSession(root, 's')?.openAISpeed).toBe('ultrafast')
    expect(sm.getSessions()[0]?.openAISpeed).toBe('ultrafast')
    expect((await sm.getSession('s'))?.openAISpeed).toBe('ultrafast')
    const restored = createManagedSession(header, workspace() as never)
    expect(restored.openAISpeed).toBe('ultrafast')
    expect(events).toContainEqual({ type: 'session_metadata_changed', sessionId: 's', changes: { openAISpeed: 'ultrafast' } })
  })

  it('rejects invalid untrusted IPC tiers without mutation', async () => {
    for (const speed of ['priority', '', null, {}, undefined]) {
      await expect(sm.setSessionOpenAISpeed('s', speed as OpenAISpeed, true)).rejects.toThrow('Invalid OpenAI speed')
    }
    expect(managed.openAISpeed).toBeUndefined()
    expect(events).toHaveLength(0)
  })

  it('requires explicit true acknowledgement for both premium tiers', async () => {
    for (const speed of ['fast', 'ultrafast'] as const) {
      for (const acknowledged of [undefined, false, 'true', 1]) {
        await expect(sm.setSessionOpenAISpeed('s', speed, acknowledged as boolean)).rejects.toThrow('acknowledg')
      }
    }
    expect(managed.openAISpeed).toBeUndefined()
    expect(events).toHaveLength(0)
  })

  it('gates effective model and native provider through shared policy', async () => {
    managed.model = 'pi/gpt-6.1-sol'
    await expect(sm.setSessionOpenAISpeed('s', 'ultrafast', true)).rejects.toThrow('not supported')
    await sm.setSessionOpenAISpeed('s', 'fast', true)
    provider = 'anthropic'
    await expect(sm.setSessionOpenAISpeed('s', 'fast', true)).rejects.toThrow('not supported')
    provider = 'openai'
    providerType = 'pi_compat'
    await expect(sm.setSessionOpenAISpeed('s', 'fast', true)).rejects.toThrow('not supported')
    expect(managed.openAISpeed).toBe('fast')
  })

  it('rejects changes while manager or backend is processing', async () => {
    managed.isProcessing = true
    await expect(sm.setSessionOpenAISpeed('s', 'standard')).rejects.toThrow('processing')
    managed.isProcessing = false
    managed.agent = { isProcessing: () => true } as never
    await expect(sm.setSessionOpenAISpeed('s', 'ultrafast', true)).rejects.toThrow('processing')
    expect(managed.openAISpeed).toBeUndefined()
  })

  it('awaits optional async backend acknowledgement before persisting or broadcasting', async () => {
    let release!: () => void
    const called: string[] = []
    managed.agent = { isProcessing: () => false, setOpenAISpeed: async (speed: string) => {
      called.push(speed)
      await new Promise<void>(r => { release = r })
    } } as never
    const pending = sm.setSessionOpenAISpeed('s', 'ultrafast', true)
    await Promise.resolve()
    expect(called).toEqual(['ultrafast'])
    expect(managed.openAISpeed).toBeUndefined()
    expect(readSessionHeader(file())).toBeNull()
    expect(events).toHaveLength(0)
    await expect(sm.setSessionOpenAISpeed('s', 'standard')).rejects.toThrow('pending')
    release()
    await pending
    expect(readSessionHeader(file())?.openAISpeed).toBe('ultrafast')
    expect(managed.openAISpeedUpdate).toBeUndefined()
  })

  it('does not persist or announce a rejected backend tier', async () => {
    managed.agent = { isProcessing: () => false, setOpenAISpeed: async () => { throw new Error('offline entitlement denial') } } as never
    await expect(sm.setSessionOpenAISpeed('s', 'ultrafast', true)).rejects.toThrow('entitlement denial')
    expect(managed.openAISpeed).toBeUndefined()
    expect(managed.openAISpeedUpdate).toBeUndefined()
    expect(readSessionHeader(file())).toBeNull()
    expect(events).toHaveLength(0)
  })

  it('rolls runtime, metadata and disk back if flushing the selected tier fails', async () => {
    await sm.setSessionOpenAISpeed('s', 'standard')
    events.length = 0
    const requests: string[] = []
    managed.agent = { isProcessing: () => false, setOpenAISpeed: async (speed: string) => { requests.push(speed) } } as never
    const realFlush = sm.flushSession.bind(sm)
    let calls = 0
    const flush = spyOn(sm, 'flushSession').mockImplementation(async id => {
      if (++calls === 1) throw new Error('offline disk unavailable')
      await realFlush(id)
    })
    try {
      await expect(sm.setSessionOpenAISpeed('s', 'ultrafast', true)).rejects.toThrow('disk unavailable')
      expect(requests).toEqual(['ultrafast', 'standard'])
      expect(managed.openAISpeed).toBe('standard')
      expect(readSessionHeader(file())?.openAISpeed).toBe('standard')
      expect(managed.openAISpeedError).toBeUndefined()
      expect(events).toHaveLength(0)
    } finally { flush.mockRestore() }
  })

  it('detects swallowed queue IO errors instead of reporting premium success', async () => {
    await sm.setSessionOpenAISpeed('s', 'standard')
    events.length = 0
    const rename = fsp.rename
    let calls = 0
    const io = spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (++calls === 1) throw new Error('offline atomic replacement failure')
      await rename(from, to)
    })
    const log = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(sm.setSessionOpenAISpeed('s', 'ultrafast', true)).rejects.toThrow('Failed to persist')
      expect(managed.openAISpeed).toBe('standard')
      expect(readSessionHeader(file())?.openAISpeed).toBe('standard')
      expect(managed.openAISpeedError).toBeUndefined()
      expect(events).toHaveLength(0)
    } finally { io.mockRestore(); log.mockRestore() }
  })

  it('blocks sends after uncertain rollback until an explicit successful tier selection', async () => {
    await sm.setSessionOpenAISpeed('s', 'standard')
    events.length = 0
    let denyRollback = true
    managed.agent = { isProcessing: () => false, setOpenAISpeed: async (speed: string) => {
      if (speed === 'standard' && denyRollback) throw new Error('offline rollback acknowledgement lost')
    } } as never
    const realFlush = sm.flushSession.bind(sm)
    let calls = 0
    const flush = spyOn(sm, 'flushSession').mockImplementation(async id => {
      if (++calls === 1) throw new Error('offline disk unavailable')
      await realFlush(id)
    })
    try {
      await expect(sm.setSessionOpenAISpeed('s', 'ultrafast', true)).rejects.toThrow('disk unavailable')
      expect(managed.openAISpeed).toBe('standard')
      expect(readSessionHeader(file())?.openAISpeed).toBe('standard')
      expect(events).toHaveLength(0)
      await expect(internal().getOrCreateAgent(managed)).rejects.toThrow('Explicitly select a speed')
      denyRollback = false
      await sm.setSessionOpenAISpeed('s', 'standard')
      expect(managed.openAISpeedError).toBeUndefined()
      expect(events).toContainEqual({ type: 'session_metadata_changed', sessionId: 's', changes: { openAISpeed: 'standard' } })
    } finally { flush.mockRestore() }
  })

  it('handles backends without the optional setter by retiring the idle runtime', async () => {
    managed.agent = { isProcessing: () => false } as never
    const dispose = spyOn(internal(), 'disposeManagedAgentRuntime').mockImplementation(async () => { managed.agent = null })
    await sm.setSessionOpenAISpeed('s', 'fast', true)
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(managed.agent).toBeNull()
    expect(readSessionHeader(file())?.openAISpeed).toBe('fast')
  })

  it('preserves requested premium after model/provider changes and blocks incompatible use', async () => {
    await sm.setSessionOpenAISpeed('s', 'ultrafast', true)
    await sm.updateSessionModel('s', workspace().id, 'pi/gpt-6.1-sol')
    await expect(internal().getOrCreateAgent(managed)).rejects.toThrow('not supported')
    expect(managed.openAISpeed).toBe('ultrafast')
    expect(readSessionHeader(file())?.openAISpeed).toBe('ultrafast')
    managed.model = 'pi/gpt-6.2-sol'
    provider = 'anthropic'
    await expect(internal().getOrCreateAgent(managed)).rejects.toThrow('not supported')
    expect(managed.openAISpeed).toBe('ultrafast')
    // Standard is an explicit escape hatch, never a silent downgrade.
    await sm.setSessionOpenAISpeed('s', 'standard')
    expect(managed.openAISpeed).toBe('standard')
  })

  it('does not inherit premium into a newly stored session, even from untrusted creation options', async () => {
    const session = await createStoredSession(root, { model: managed.model, openAISpeed: 'ultrafast' } as never)
    expect(session.openAISpeed).toBeUndefined()
    expect(loadSession(root, session.id)?.openAISpeed).toBeUndefined()
    expect(session.model).toBe(managed.model)
  })

  it('preserves premium on same-session move but not a bundle fork', async () => {
    const lookup = spyOn(config, 'getWorkspaceByNameOrId').mockReturnValue(workspace() as never)
    try {
      const bundle: SessionBundle = {
        version: 1,
        session: {
          header: { id: 'source', workspaceRootPath: root, createdAt: 1, lastUsedAt: 2, model: managed.model, openAISpeed: 'ultrafast' } as SessionBundle['session']['header'],
          messages: [],
        },
        files: [],
      }
      const moved = await sm.importSession(workspace().id, bundle, 'move')
      expect(moved.sessionId).toBe('source')
      expect(loadSession(root, moved.sessionId)?.openAISpeed).toBe('ultrafast')
      const forked = await sm.importSession(workspace().id, bundle, 'fork')
      expect(forked.sessionId).not.toBe(moved.sessionId)
      expect(loadSession(root, forked.sessionId)?.openAISpeed).toBeUndefined()
      expect((await sm.getSession(forked.sessionId))?.openAISpeed).toBeUndefined()
    } finally {
      lookup.mockRestore()
    }
  })

  it('does not inherit paid speed in spawn or continue-new options', async () => {
    managed.openAISpeed = 'ultrafast'
    const child = spawnedSessionOptions({}, managed)
    expect(child).not.toHaveProperty('openAISpeed')
    expect(child.model).toBe(managed.model)
    const create = spyOn(sm, 'createSession').mockResolvedValue({ id: 'child' } as never)
    await sm.continueSessionInNewSession('s', true)
    expect(create.mock.calls[0]?.[1]).not.toHaveProperty('openAISpeed')
    expect(managed.openAISpeed).toBe('ultrafast')
  })
})
