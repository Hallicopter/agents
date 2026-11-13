/** Pure measured-height layout for opt-in session-list windowing. Logical items,
 * grouping/pagination and selection stay owned by the existing SessionList. */
export interface WindowGroupInput { key: string; rowKeys: string[] }
export interface WindowRow { key: string; index: number; start: number; size: number }
export interface WindowGroup { key: string; start: number; headerSize: number; size: number; rows: WindowRow[] }
export interface WindowLayout { groups: WindowGroup[]; rows: WindowRow[]; byKey: Map<string, WindowRow>; size: number }
export const rowMeasureKey = (key: string) => `row:${key}`
export const headerMeasureKey = (key: string) => `header:${key}`

export function layoutWindowedGroups(groups: WindowGroupInput[], sizes: ReadonlyMap<string, number>, estimate = 56): WindowLayout {
  let offset = 0
  const rows: WindowRow[] = []
  const byKey = new Map<string, WindowRow>()
  const result = groups.map((group, groupIndex) => {
    if (groupIndex > 0) offset += 8 // existing mt-2 between groups
    const start = offset
    const headerSize = sizes.get(headerMeasureKey(group.key)) ?? 32
    offset += headerSize
    const groupRows = group.rowKeys.map((key, index) => {
      const row = { key, index, start: offset, size: sizes.get(rowMeasureKey(key)) ?? estimate }
      offset += row.size; rows.push(row); byKey.set(key, row)
      return row
    })
    return { key: group.key, start, headerSize, size: offset - start, rows: groupRows }
  })
  return { groups: result, rows, byKey, size: offset }
}

/** Include pinned keyboard/selection/menu anchors even outside the viewport.
 * Sparse indices are rendered with sized gaps, not concatenated at the top. */
export function visibleWindowRows(group: WindowGroup, top: number, height: number, pinned: ReadonlySet<string>, overscan = 240): WindowRow[] {
  const end = top + height + overscan
  return group.rows.filter(row => pinned.has(row.key) || (row.start + row.size > top - overscan && row.start < end))
}

export function windowAnchor(layout: WindowLayout, offset: number): WindowRow | undefined {
  return layout.rows.find(row => row.start + row.size > offset)
}

export function anchorShift(previous: WindowLayout, next: WindowLayout, offset: number): number {
  const anchor = windowAnchor(previous, offset)
  const replacement = anchor && next.byKey.get(anchor.key)
  return anchor && replacement ? replacement.start - anchor.start : 0
}
