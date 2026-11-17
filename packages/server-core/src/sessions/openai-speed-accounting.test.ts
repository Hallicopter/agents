import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionManager, createManagedSession } from './SessionManager'
import { saveSession, loadSession, readSessionHeader, sessionPersistenceQueue } from '@craft-agent/shared/sessions'
import { capturedSpeedEvents } from '../../../pi-agent-server/src/test-fixtures/openai-speed-captured'

// Real sanitized provider mismatch metadata, replayed locally. NO auth/subprocess/network.
// Ultrafast success is a clearly synthetic variant, not an entitlement proof.
describe('OpenAI captured consumption through canonical session persistence', () => {
  for (const applied of ['default', 'ultrafast'] as const) {
    it(`persists and reloads actual token counts for ${applied === 'default' ? 'rejected mismatch/Standard estimate' : 'synthetic confirmed success'}`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'speed-consumption-'))
      const id = `offline-${applied}`
      const workspace = { id: 'offline-workspace', name: 'Offline accounting', rootPath: root, createdAt: 1 }
      const sm = new SessionManager()
      try {
        const capture = await capturedSpeedEvents(applied)
        const managed = createManagedSession({ id, name: 'Offline accounting check', model: 'pi/gpt-6.2-sol', openAISpeed: 'ultrafast' }, workspace as never, { messagesLoaded: true })
        managed.llmConnection = 'offline-native-oauth'
        const internals = sm as any
        internals.sessions.set(id, managed)
        await saveSession({ id, workspaceRootPath: root, name: managed.name, model: managed.model,
          llmConnection: managed.llmConnection, openAISpeed: 'ultrafast', createdAt: 1, lastUsedAt: 1, messages: [] } as any)
        const events: any[] = []
        const completed = Promise.withResolvers<void>()
        internals.sendEvent = (event: any) => { events.push(event); if (event.type === 'complete') completed.resolve() }
        internals.startPreTurnDecisions = async () => ({ thinkingOverride: null, suggestionHint: null })
        const agent = { getModel: () => 'pi/gpt-6.2-sol', setAllSources: () => {}, getSessionId: () => 'offline-sdk',
          chat: async function* () {
            for (const report of capture.reports) yield { type: 'info', message: report.message }
            yield* capture.events
          } }
        internals.getOrCreateAgent = async () => agent
        await sm.sendMessage(id, 'OFFLINE captured accounting replay; no provider calls')
        const timeout = setTimeout(() => completed.reject(new Error('Canonical completion was not published')), 1000)
        try { await completed.promise } finally { clearTimeout(timeout) }
        await sm.flushSession(id)
        const expected = { inputTokens: 6714, outputTokens: 14, totalTokens: 6728 }
        const multiplier = applied === 'default' ? 1 : 3
        const cost = capture.baseCostEstimate * multiplier
        expect(managed.tokenUsage).toMatchObject(expected)
        expect(managed.tokenUsage?.costUsd).toBeCloseTo(cost, 9)
        expect(events.findLast(e => e.type === 'complete')?.tokenUsage).toMatchObject(expected)
        expect(events.findLast(e => e.type === 'complete')?.tokenUsage.costUsd).toBeCloseTo(cost, 9)
        expect(managed.openAISpeed).toBe('ultrafast') // request is not silently downgraded
        const stored = loadSession(root, id)!
        const header = readSessionHeader(join(root, 'sessions', id, 'session.jsonl'))!
        expect(stored.tokenUsage).toMatchObject(expected)
        expect(stored.tokenUsage?.costUsd).toBeCloseTo(cost, 9)
        expect(header.tokenUsage).toMatchObject(expected)
        expect(header.tokenUsage?.costUsd).toBeCloseTo(cost, 9)
        const restoredManager = new SessionManager()
        const restored = createManagedSession(header, workspace as never)
        ;(restoredManager as any).sessions.set(id, restored)
        const dto = await restoredManager.getSession(id)
        expect(dto?.tokenUsage).toMatchObject(expected)
        expect(dto?.tokenUsage?.costUsd).toBeCloseTo(cost, 9)
        expect(dto?.openAISpeed).toBe('ultrafast')
        if (applied === 'default') {
          expect(cost).toBeCloseTo(0.013568, 9)
          expect(dto?.messages.some(m => m.role === 'error' && m.content.includes('received default'))).toBe(true)
          expect(dto?.messages.some(m => m.role === 'assistant')).toBe(false)
        } else {
          expect(dto?.messages.some(m => m.role === 'assistant' && m.content.includes('OFFLINE_ACCOUNTING_VARIANT'))).toBe(true)
        }
        expect(capture.requests).toBe(1)
      } finally {
        await sessionPersistenceQueue.flush(id)
        rmSync(root, { recursive: true, force: true })
      }
    })
  }
})
