import { describe, expect, test } from 'bun:test'
import { defaultSessionOptions, mergeSessionOptionsFromSnapshots, type SessionOptions } from '../useSessionOptions'

describe('session options from bounded or complete inventory', () => {
  test('seeds all displayed modes and previous mode without filling the map with defaults', () => {
    const inventory = Array.from({ length: 27_951 }, (_, i) => ({ id: `session-${i}` }))
    const opts = mergeSessionOptionsFromSnapshots(new Map(), [
      ...inventory, { id: 'session-1', permissionMode: 'safe', previousPermissionMode: 'guarded' },
      { id: 'session-2', codingMode: true }, { id: 'session-3', permissionMode: 'ask', previousPermissionMode: 'safe' },
    ])
    expect(opts.size).toBe(3)
    expect(opts.get('session-1')).toEqual({ ...defaultSessionOptions, permissionMode: 'safe', previousPermissionMode: 'guarded' })
    expect(opts.get('session-2')?.codingMode).toBe(true)
    expect(opts.get('session-3')?.previousPermissionMode).toBe('safe')
  })

  test('refresh keeps an omitted session and transition version, without mutating old state', () => {
    const previous = new Map<string, SessionOptions>([
      ['not-in-response', { ...defaultSessionOptions, permissionMode: 'safe' }],
      ['updated', { ...defaultSessionOptions, permissionMode: 'safe', previousPermissionMode: 'guarded', permissionModeVersion: 7 }],
      ['now-default', { ...defaultSessionOptions, codingMode: true }],
    ])
    const opts = mergeSessionOptionsFromSnapshots(previous, [
      { id: 'updated', permissionMode: 'ask' }, { id: 'now-default' },
    ])
    expect(opts.get('not-in-response')).toBe(previous.get('not-in-response'))
    expect(opts.get('updated')).toEqual(previous.get('updated'))
    expect(opts.has('now-default')).toBe(false)
    expect(previous.get('updated')?.previousPermissionMode).toBe('guarded')
    expect(previous.get('now-default')?.codingMode).toBe(true)
  })
})
