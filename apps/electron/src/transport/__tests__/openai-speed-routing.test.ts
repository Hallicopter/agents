import { describe, expect, it } from 'bun:test'
import type { RpcClient } from '@craft-agent/server-core/transport'
import { buildClientApi } from '../build-api'
import { CHANNEL_MAP } from '../channel-map'
import { RPC_CHANNELS } from '../../shared/types'
import { requestSessionOpenAISpeed } from '../../renderer/lib/openai-speed-command'

describe('OpenAI speed through the shared Electron/browser client route', () => {
  it('uses the session command RPC, not a model or connection setter', async () => {
    const calls: unknown[][] = []
    const client = {
      invoke: async (...args: unknown[]) => { calls.push(args); return { success: true } },
      on: () => () => {},
    } as unknown as RpcClient
    // Both preload and WebUI create this exact client API + channel map.
    const api = buildClientApi(client, CHANNEL_MAP)
    await requestSessionOpenAISpeed((id, command) => api.sessionCommand(id, command), 'synthetic', 'fast', true)
    expect(calls).toEqual([[
      RPC_CHANNELS.sessions.COMMAND, 'synthetic',
      { type: 'setOpenAISpeed', speed: 'fast', acknowledged: true },
    ]])
  })

  it('keeps shared-route command failures visible to the confirmation caller', async () => {
    const client = {
      invoke: async () => ({ success: false, error: 'Synthetic provider restriction' }),
      on: () => () => {},
    } as unknown as RpcClient
    const api = buildClientApi(client, CHANNEL_MAP)
    await expect(requestSessionOpenAISpeed((id, command) => api.sessionCommand(id, command), 'synthetic', 'ultrafast', true)).rejects.toThrow('Synthetic provider restriction')
  })
})
