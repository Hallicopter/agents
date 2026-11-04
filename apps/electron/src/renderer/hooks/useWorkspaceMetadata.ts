import { useCallback, useEffect, useRef, useState } from 'react'
import { createWorkspaceMetadataLoader } from './workspace-metadata-loader'

export interface WorkspaceMetadataSource<T> {
  load: (workspaceId: string) => Promise<T[]>
  subscribe: (onChange: (workspaceId: string) => void) => () => void
}

/** Labels/statuses/views share a workspace-scoped hydration lifecycle. Sources
 * are module constants: subscribe before fetching, retry on transport recovery,
 * and ignore in-flight responses after workspace switching or unmounting.
 */
export function useWorkspaceMetadata<T>(workspaceId: string | null, source: WorkspaceMetadataSource<T>) {
  const [state, setState] = useState<{ workspaceId: string | null; data: T[]; isLoading: boolean; error: string | null }>({
    workspaceId: null, data: [], isLoading: !!workspaceId, error: null,
  })
  const loaderRef = useRef<ReturnType<typeof createWorkspaceMetadataLoader<T[]>> | null>(null)
  const refresh = useCallback(async () => { await loaderRef.current?.refresh() }, [])

  useEffect(() => {
    setState({ workspaceId, data: [], isLoading: !!workspaceId, error: null })
    if (!workspaceId) return
    const loader = createWorkspaceMetadataLoader({
      load: () => source.load(workspaceId),
      onData: data => setState(s => ({ ...s, data })),
      onLoading: isLoading => setState(s => ({ ...s, isLoading })),
      onError: error => setState(s => ({ ...s, error })),
    })
    loaderRef.current = loader
    const unsubscribe = source.subscribe(changedWorkspaceId => {
      if (changedWorkspaceId === workspaceId) void loader.refresh()
    })
    // RoutedClient immediately emits its current snapshot when subscribing.
    // The initial fetch below handles that; duplicate connected snapshots must
    // not create a request storm or invalidate a pending successful response.
    let subscribing = true
    let previousStatus: string | undefined
    let previousUrl: string | undefined
    const unsubscribeTransport = window.electronAPI.onTransportConnectionStateChanged?.(next => {
      const recovered = next.status === 'connected' && (previousStatus !== 'connected' || previousUrl !== next.url)
      previousStatus = next.status
      previousUrl = next.url
      if (!subscribing && recovered) void loader.refresh()
    })
    subscribing = false
    void loader.refresh()
    return () => {
      loader.dispose()
      loaderRef.current = null
      unsubscribe()
      unsubscribeTransport?.()
    }
  }, [workspaceId, source])

  // Do not expose the preceding workspace's labels for even one render.
  return state.workspaceId === workspaceId
    ? { ...state, refresh }
    : { workspaceId, data: [] as T[], isLoading: !!workspaceId, error: null, refresh }
}
