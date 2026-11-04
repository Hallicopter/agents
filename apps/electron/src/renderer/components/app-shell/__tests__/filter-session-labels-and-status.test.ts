import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { filterSessionLabelsAndStatus } from '../filter-session-labels-and-status'
import type { FilterMode } from '../inherited-filter-params'
const tree = [{ id: 'puck', name: 'Puck', children: [{ id: 'puck-subagent', name: 'Worker' }] }, { id: 'puck-automation', name: 'Automation' }]
const sessions = [
  { id: 'parent', labels: ['puck'] },
  { id: 'worker', sessionStatus: 'needs-review', labels: ['puck-subagent::42'] },
  { id: 'automation', sessionStatus: 'todo', labels: ['puck-automation'] },
  { id: 'done', sessionStatus: 'done', labels: ['puck-subagent'] },
  { id: 'plain', sessionStatus: 'todo' },
]
const modes = (...pairs: Array<[string, FilterMode]>) => new Map(pairs)
const ids = (statuses = modes(), labels = modes(), configs = tree) => filterSessionLabelsAndStatus(sessions, statuses, labels, configs).map(s => s.id)

describe('production sidebar secondary filters', () => {
  it('preserves total count and object identity without filters', () => {
    expect(ids()).toHaveLength(5)
    expect(filterSessionLabelsAndStatus(sessions, modes(), modes(), tree)).toBe(sessions)
  })
  it('expands descendants and valued labels only after definitions hydrate', () => {
    expect(ids(modes(), modes(['puck', 'include']), [])).toEqual(['parent'])
    expect(ids(modes(), modes(['puck', 'include']))).toEqual(['parent', 'worker', 'done'])
  })
  it('ANDs status with labels, defaults absent status to todo', () => {
    expect(ids(modes(['todo', 'include']), modes(['puck', 'include']))).toEqual(['parent'])
    expect(ids(modes(['needs-review', 'include']), modes(['puck', 'include']))).toEqual(['worker'])
  })
  it('ORs includes and applies exclusions last across descendants', () => {
    expect(ids(modes(['done', 'exclude']), modes(['puck', 'include'], ['puck-automation', 'include']))).toEqual(['parent', 'worker', 'automation'])
    expect(ids(modes(), modes(['puck', 'include'], ['puck-subagent', 'exclude']))).toEqual(['parent'])
    expect(ids(modes(), modes(['puck', 'exclude']))).toEqual(['automation', 'plain'])
  })
  it('does not mutate persisted metadata while filtering', () => {
    const before = JSON.stringify(sessions)
    ids(modes(['done', 'exclude']), modes(['puck', 'include']))
    expect(JSON.stringify(sessions)).toBe(before)
  })
  it('AppShell invalidates the filtered set when late/reconnected views compile', () => {
    const source = readFileSync(new URL('../AppShell.tsx', import.meta.url), 'utf8')
    const memo = source.slice(source.indexOf('const filteredSessionMetas = useMemo'), source.indexOf('// Derive "pinned"'))
    expect(memo).toContain('filterSessionLabelsAndStatus(result, listFilter, labelFilter, labelConfigs)')
    expect(memo).toContain('projectFilter, labelConfigs, evaluateViews])')
  })
})
