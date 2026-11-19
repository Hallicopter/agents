import { expect, it } from 'bun:test'
import { piAutoCompactionFocusForSession } from './pi-auto-compaction-focus'

it('enables automatic focus only for an exact Puck role on an interactive session', () => {
  expect(piAutoCompactionFocusForSession({ labels: ['project', 'puck'] })).toBe('puck')
  for (const labels of [undefined, [], ['Puck'], ['puck::true'], ['puck-other'], ['puck-subagent'],
    ['puck-automation'], ['puck', 'puck-subagent'], ['puck', 'puck-automation']]) {
    expect(piAutoCompactionFocusForSession({ labels })).toBeUndefined()
  }
  expect(piAutoCompactionFocusForSession({ labels: ['puck'], triggeredBy: { automationName: 'scheduled' } }))
    .toBeUndefined()
})
