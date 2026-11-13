import { describe, expect, it } from 'bun:test'
import { anchorShift, headerMeasureKey, layoutWindowedGroups, rowMeasureKey, refreshMeasuredLayout, visibleWindowRows, windowAnchor } from '../windowed-list-layout'

const input = (count: number) => [{ key: 'today', rowKeys: Array.from({ length: count }, (_, n) => `s-${n}`) }]
describe('exceptional session-list measured window layout', () => {
  it('bounds rendered rows while keeping the complete logical scroll extent', () => {
    const model = layoutWindowedGroups(input(1000), new Map())
    expect(model.rows.length).toBe(1000)
    expect(model.size).toBe(56032)
    const visible = visibleWindowRows(model.groups[0], 10000, 800, new Set())
    expect(visible.length).toBeLessThan(25)
    expect(visible.every(row => row.start + row.size > 9760 && row.start < 11040)).toBe(true)
  })
  it('retains sparse keyboard, selected and menu anchors in original order and position', () => {
    const model = layoutWindowedGroups(input(1000), new Map())
    const visible = visibleWindowRows(model.groups[0], 500, 800, new Set(['s-0', 's-999', 's-600']))
    expect(visible[0].key).toBe('s-0')
    expect(visible.at(-1)?.key).toBe('s-999')
    expect(visible.find(row => row.key === 's-600')?.start).toBe(33632)
    expect(visible.length).toBeLessThan(35)
    expect(visible.map(row => row.index)).toEqual([...visible.map(row => row.index)].sort((a, b) => a - b))
  })
  it('measures variable title/subtitle heights and headers, including collapsed placeholders', () => {
    const groups = [{ key: 'collapsed', rowKeys: [] }, ...input(3), { key: 'old', rowKeys: ['old'] }]
    const model = layoutWindowedGroups(groups, new Map([[rowMeasureKey('s-0'), 37], [rowMeasureKey('s-1'), 76], [headerMeasureKey('today'), 40]]))
    expect(model.groups[0].size).toBe(32)
    expect(model.groups[1].start).toBe(40)
    expect(model.rows[0].start).toBe(80)
    expect(model.rows[2].start).toBe(193)
    expect(model.groups[2].start).toBe(257)
    expect(model.size).toBe(345)
    expect(visibleWindowRows(model.groups[0], 0, 800, new Set())).toEqual([])
  })
  it('keeps the first visible row anchored across resizes above it and reorders', () => {
    const before = layoutWindowedGroups(input(1000), new Map())
    const resized = layoutWindowedGroups(input(1000), new Map([[rowMeasureKey('s-0'), 96]]))
    expect(windowAnchor(before, 1000)?.key).toBe('s-17')
    expect(anchorShift(before, resized, 1000)).toBe(40)
    const reordered = layoutWindowedGroups([{ key: 'today', rowKeys: ['new', ...input(1000)[0].rowKeys] }], new Map())
    expect(anchorShift(before, reordered, 1000)).toBe(56)
    expect(anchorShift(before, layoutWindowedGroups([], new Map()), 1000)).toBe(0)
  })
  it('refreshes inactive estimated snapshots before scrolled200 -> 201 activation', () => {
    const stale = layoutWindowedGroups(input(200), new Map())
    const sizes = new Map(input(200)[0].rowKeys.map(key => [rowMeasureKey(key), 36]))
    const next = layoutWindowedGroups(input(201), sizes)
    // Nothing above the viewport changed. Choosing from a stale estimated
    // model incorrectly subtracts1060px even though the full DOM was measured.
    expect(anchorShift(stale, next, 3000)).toBe(-1060)
    const actualPrevious = refreshMeasuredLayout(stale, sizes)
    expect(actualPrevious.rows.map(row => row.key)).toEqual(stale.rows.map(row => row.key))
    expect(anchorShift(actualPrevious, next, 3000)).toBe(0)
    expect(anchorShift(actualPrevious, next, actualPrevious.size - 800)).toBe(0)
    expect(anchorShift(next, actualPrevious, 3000)).toBe(0)
  })
  it('preserves exact row coordinates through group collapse, search regrouping and hierarchy flattening', () => {
    const before = layoutWindowedGroups([{ key: 'a', rowKeys: ['parent', 'child-1', 'child-2'] }, { key: 'b', rowKeys: ['other'] }], new Map())
    const after = layoutWindowedGroups([{ key: 'a', rowKeys: [] }, { key: 'b', rowKeys: ['other'] }], new Map())
    expect(after.rows.map(row => row.key)).toEqual(['other'])
    expect(anchorShift(before, after, before.byKey.get('other')!.start)).toBe(-168)
    const search = layoutWindowedGroups([{ key: 'matching', rowKeys: ['child-1'] }, { key: 'other', rowKeys: ['parent'] }], new Map())
    expect(search.rows.map(row => row.key)).toEqual(['child-1', 'parent'])
    expect(search.rows[0].index).toBe(0)
    expect(search.rows[1].index).toBe(0)
  })
})
