import * as React from 'react'
import type { EntityListGroup } from './entity-list'
import { anchorShift, headerMeasureKey, layoutWindowedGroups, rowMeasureKey, visibleWindowRows, type WindowLayout } from './windowed-list-layout'

interface Props<T> {
  groups: EntityListGroup<T>[]
  getKey: (item: T) => string
  renderItem: (item: T, index: number, isFirst: boolean) => React.ReactNode
  renderHeader: (group: EntityListGroup<T>) => React.ReactNode
  viewportRef: React.RefObject<HTMLDivElement>
  pinnedKeys: readonly string[]
  enabled: boolean
}

/** Only used by exceptionally large paged session lists. Keeps existing group
 * containers/headers and the complete logical navigation model. Heights are
 * measured, not fixed; sparse pinned keyboard/menu rows retain their real place. */
export function WindowedEntityGroups<T>({ groups, getKey, renderItem, renderHeader, viewportRef, pinnedKeys, enabled }: Props<T>) {
  const enabledRef = React.useRef(enabled)
  React.useLayoutEffect(() => { enabledRef.current = enabled }, [enabled])
  const root = React.useRef<HTMLDivElement>(null)
  const sizes = React.useRef(new Map<string, number>())
  const elements = React.useRef(new Map<string, HTMLElement>())
  const callbacks = React.useRef(new Map<string, (node: HTMLDivElement | null) => void>())
  const observer = React.useRef<ResizeObserver | null>(null)
  const measurementFrame = React.useRef(0)
  const [revision, setRevision] = React.useState(0)
  const [view, setView] = React.useState({ top: 0, height: 800, width: 0, offset: 0 })
  const [retainedKey, setRetainedKey] = React.useState<string | null>(null)
  const previousLayout = React.useRef<WindowLayout | null>(null)
  const previousEnabled = React.useRef(enabled)
  const lastView = React.useRef(view)
  const inputs = React.useMemo(() => groups.map(group => ({ key: group.key, rowKeys: group.items.map(getKey) })), [groups, getKey])
  const model = React.useMemo(() => layoutWindowedGroups(inputs, sizes.current), [inputs, revision, enabled])

  const readViewport = React.useCallback(() => {
    const viewport = viewportRef.current
    const content = root.current
    if (!viewport || !content) return
    const next = { top: viewport.scrollTop, height: viewport.clientHeight, width: viewport.clientWidth,
      offset: content.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop }
    lastView.current = next
    if (!enabledRef.current) return // ordinary scrolling must not re-render all rows
    setView(old => old.top === next.top && old.height === next.height && old.width === next.width && Math.abs(old.offset - next.offset) < 0.5 ? old : next)
  }, [viewportRef])

  const measure = React.useCallback((key: string, node: HTMLElement) => {
    const size = node.getBoundingClientRect().height
    if (size > 0 && Math.abs((sizes.current.get(key) ?? -1) - size) > 0.5) {
      sizes.current.set(key, size)
      if (!measurementFrame.current) measurementFrame.current = requestAnimationFrame(() => {
        measurementFrame.current = 0
        if (enabledRef.current) setRevision(n => n + 1)
      })
    }
  }, [])

  const bind = React.useCallback((key: string) => {
    let callback = callbacks.current.get(key)
    if (!callback) {
      callback = node => {
        const old = elements.current.get(key)
        if (old) observer.current?.unobserve(old)
        if (node) {
          elements.current.set(key, node)
          observer.current?.observe(node)
          measure(key, node)
        } else elements.current.delete(key)
      }
      callbacks.current.set(key, callback)
    }
    return callback
  }, [measure])

  // The viewport is an ANCESTOR host ref. A child's layout effect runs before
  // that ref is attached on initial mount; bind in the passive effect instead.
  React.useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    observer.current = new ResizeObserver(entries => {
      for (const entry of entries) {
        const node = entry.target as HTMLElement
        const key = node.dataset.windowMeasure
        if (key) measure(key, node)
        if (node === viewport) {
          if (lastView.current.width && lastView.current.width !== viewport.clientWidth) {
            // Offscreen measurements may wrap differently at the new width.
            sizes.current.clear()
            setRevision(n => n + 1)
            for (const [key, element] of elements.current) measure(key, element)
          }
          readViewport()
        }
      }
    })
    observer.current.observe(viewport)
    for (const [key, node] of elements.current) { observer.current.observe(node); measure(key, node) }
    viewport.addEventListener('scroll', readViewport, { passive: true })
    readViewport()
    return () => {
      viewport.removeEventListener('scroll', readViewport)
      observer.current?.disconnect(); observer.current = null
      cancelAnimationFrame(measurementFrame.current); measurementFrame.current = 0
    }
  }, [measure, readViewport, viewportRef])

  React.useLayoutEffect(() => {
    const viewport = viewportRef.current
    const previous = previousLayout.current
    const snapshot = lastView.current
    // Newly mounted full rows have measured refs before this effect. On the
    // window -> full transition use those actual heights, not old estimates.
    const next = previousEnabled.current && !enabled ? layoutWindowedGroups(inputs, sizes.current) : model
    // Hold the first visible row steady when measured heights or rows ABOVE it
    // change. At the top allow new activity/reorders to appear naturally.
    if ((enabled || previousEnabled.current) && viewport && previous && snapshot.top > snapshot.offset + 1) {
      const delta = anchorShift(previous, next, snapshot.top - snapshot.offset)
      // Native layout may ALREADY clamp scrollTop when the extent shrinks.
      // Restore the snapshot's target, not a delta on the clamped position.
      if (Math.abs(delta) > 0.5) viewport.scrollTop = snapshot.top + delta
    }
    previousLayout.current = next
    previousEnabled.current = enabled
    readViewport()
    const valid = new Set(model.rows.map(row => rowMeasureKey(row.key)))
    for (const group of model.groups) valid.add(headerMeasureKey(group.key))
    for (const key of sizes.current.keys()) if (!valid.has(key)) sizes.current.delete(key)
    for (const key of callbacks.current.keys()) if (!valid.has(key)) callbacks.current.delete(key)
  }, [model, inputs, readViewport, viewportRef, enabled])

  const pinned = new Set(pinnedKeys)
  if (retainedKey) pinned.add(retainedKey)
  const retainAnchor = (event: React.SyntheticEvent) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-window-row-key]')
    if (row) setRetainedKey(row.dataset.windowRowKey ?? null)
  }

  // Keep the same keyed row/header boundary below the threshold too. Switching
  // only visibility preserves local menu/focus state at 200 <-> 201 rows.
  return <div ref={root} style={{ overflowAnchor: enabled ? 'none' : undefined }} data-windowed-list={enabled ? 'true' : undefined}
    onFocusCapture={retainAnchor} onPointerDownCapture={retainAnchor}>
    {model.groups.map((groupLayout, groupIndex) => {
      const group = groups[groupIndex]
      const visible = enabled ? visibleWindowRows(groupLayout, view.top - view.offset, view.height, pinned) : groupLayout.rows
      const children: React.ReactNode[] = []
      let cursor = groupLayout.start + groupLayout.headerSize
      for (const row of visible) {
        if (row.start > cursor) children.push(<div aria-hidden="true" key={`gap:${row.key}`} style={{ height: row.start - cursor }} />)
        const measurementKey = rowMeasureKey(row.key)
        children.push(<div key={row.key} ref={bind(measurementKey)} data-window-measure={measurementKey} data-window-row-key={row.key}>
          {renderItem(group.items[row.index], row.index, row.index === 0)}
        </div>)
        cursor = row.start + row.size
      }
      const end = groupLayout.start + groupLayout.size
      if (end > cursor) children.push(<div aria-hidden="true" key="bottom-gap" style={{ height: end - cursor }} />)
      const measurementKey = headerMeasureKey(group.key)
      return <div key={group.key} className={groupIndex > 0 ? 'mt-2' : undefined}>
        {/* Sticky wrapper stays inside the complete (spacer-backed) group. */}
        <div ref={bind(measurementKey)} data-window-measure={measurementKey} className="sticky top-0 z-sticky">{renderHeader(group)}</div>
        {children}
      </div>
    })}
  </div>
}
