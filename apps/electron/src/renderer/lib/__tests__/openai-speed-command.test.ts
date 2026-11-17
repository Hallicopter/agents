import { describe, expect, it } from 'bun:test'
import { requestSessionOpenAISpeed } from '../openai-speed-command'
import type { SessionCommand } from '@craft-agent/shared/protocol'

describe('OpenAI speed command shared by desktop and web', () => {
  it('sends an explicit acknowledged premium request to this session only', async () => {
    const calls: Array<[string, SessionCommand]> = []
    await requestSessionOpenAISpeed(async (id, command) => {
      calls.push([id, command])
      return { success: true }
    }, 'conversation', 'ultrafast', true)
    expect(calls).toEqual([['conversation', { type: 'setOpenAISpeed', speed: 'ultrafast', acknowledged: true }]])
  })

  it('sends Standard without a paid-tier acknowledgment or any model/connection change', async () => {
    let received: SessionCommand | undefined
    await requestSessionOpenAISpeed(async (_id, command) => { received = command }, 'conversation', 'standard')
    expect(received).toEqual({ type: 'setOpenAISpeed', speed: 'standard' })
  })

  it('awaits the command instead of treating dispatch as success', async () => {
    let release!: () => void
    let completed = false
    const response = new Promise<void>(resolve => { release = resolve })
    const request = requestSessionOpenAISpeed(() => response, 'conversation', 'fast', true).then(() => { completed = true })
    await Promise.resolve()
    expect(completed).toBe(false)
    release()
    await request
    expect(completed).toBe(true)
  })

  it('propagates transport and policy rejection for the confirmation UI', async () => {
    await expect(requestSessionOpenAISpeed(async () => { throw new Error('Disconnected') }, 'conversation', 'fast', true)).rejects.toThrow('Disconnected')
    await expect(requestSessionOpenAISpeed(async () => ({ success: false, error: 'Session is processing' }), 'conversation', 'fast', true)).rejects.toThrow('Session is processing')
    await expect(requestSessionOpenAISpeed(async () => ({ error: 'Account access was not verified' }), 'conversation', 'fast', true)).rejects.toThrow('Account access was not verified')
    await expect(requestSessionOpenAISpeed(async () => ({ success: false }), 'conversation', 'fast', true)).rejects.toThrow('could not be saved')
  })
})
