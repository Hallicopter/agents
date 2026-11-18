import { expect, test } from 'bun:test'
import { pickerModels } from './ultrafast-picker'
import type { LlmConnectionWithStatus } from '@config/llm-connections'
test('adds an explicit choice only beside Standard Sol on native Codex OAuth', () => {
  const models = ['pi/gpt-6.2-sol']; const conn = { providerType: 'pi', authType: 'oauth', piAuthProvider: 'openai-codex', isAuthenticated: true } as LlmConnectionWithStatus
  expect(pickerModels(models, conn)).toMatchObject([models[0], {name:'GPT-6.2 Sol Ultrafast'}]);
  for (const change of [{authType:'api_key'}, {baseUrl:'https://example.invalid'}, {piAuthProvider:'openai'}, {isAuthenticated:false}]) expect(pickerModels(models, {...conn,...change} as LlmConnectionWithStatus)).toBe(models)
})

test('a status-list round trip yields one choice; stale or ineligible rows disappear', () => {
  const conn = { providerType: 'pi', authType: 'oauth', piAuthProvider: 'openai-codex', isAuthenticated: true } as LlmConnectionWithStatus
  const sol = 'pi/gpt-6.2-sol', ultra = `${sol}-ultrafast`
  const fromOldServer = pickerModels([sol], conn)
  expect(pickerModels([...fromOldServer, ultra], conn)).toEqual(fromOldServer)
  expect(pickerModels(fromOldServer, { ...conn, isAuthenticated: false })).toEqual([sol])
  expect(pickerModels([ultra], conn)).toEqual([])
})
