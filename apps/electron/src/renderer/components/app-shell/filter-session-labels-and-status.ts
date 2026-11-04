import { extractLabelId, getDescendantIds, type LabelConfig } from '@craft-agent/shared/labels'
import type { FilterMode } from './inherited-filter-params'

/** Secondary filters shared by AppShell and its regression harness.
 * Includes are OR-ed within a dimension; dimensions are AND-ed; exclusions win.
 * Returning the original entries preserves the session metadata (no writes).
 */
export function filterSessionLabelsAndStatus<T extends { sessionStatus?: string; labels?: string[] }>(
  sessions: T[],
  listFilter: ReadonlyMap<string, FilterMode>,
  labelFilter: ReadonlyMap<string, FilterMode>,
  labelConfigs: LabelConfig[],
): T[] {
  let result = sessions
    if (listFilter.size > 0) {
      const statusIncludes = new Set<string>()
      const statusExcludes = new Set<string>()
      for (const [id, mode] of listFilter) {
        if (mode === 'include') statusIncludes.add(id)
        else statusExcludes.add(id)
      }
      if (statusIncludes.size > 0) {
        result = result.filter(s => statusIncludes.has((s.sessionStatus || 'todo')))
      }
      if (statusExcludes.size > 0) {
        result = result.filter(s => !statusExcludes.has((s.sessionStatus || 'todo')))
      }
    }
    // Filter by labels — supports include/exclude with descendant expansion
    if (labelFilter.size > 0) {
      const labelIncludes = new Set<string>()
      const labelExcludes = new Set<string>()
      for (const [id, mode] of labelFilter) {
        // Expand to include descendant label IDs
        const ids = [id, ...getDescendantIds(labelConfigs, id)]
        for (const expandedId of ids) {
          if (mode === 'include') labelIncludes.add(expandedId)
          else labelExcludes.add(expandedId)
        }
      }
      if (labelIncludes.size > 0) {
        result = result.filter(s =>
          s.labels?.some(l => labelIncludes.has(extractLabelId(l)))
        )
      }
      if (labelExcludes.size > 0) {
        result = result.filter(s =>
          !s.labels?.some(l => labelExcludes.has(extractLabelId(l)))
        )
      }
    }
  return result
}
