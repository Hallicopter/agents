/** Read-only metadata recovery. A failed initial RPC must not leave the sidebar
 * empty for the rest of the connection. Retry briefly, then wait for an explicit
 * refresh/config/connected event; never poll indefinitely or write defaults.
 */
export function createWorkspaceMetadataLoader<T>({ load, onData, onLoading, onError, timers = {
  set: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clear: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
} }: {
  load: () => Promise<T>
  onData: (data: T) => void
  onLoading: (loading: boolean) => void
  onError: (error: string | null) => void
  timers?: { set: (fn: () => void, ms: number) => unknown; clear: (id: unknown) => void }
}) {
  let disposed = false
  let generation = 0
  let retry: unknown
  const delays = [1000, 2000, 4000]
  const cancelRetry = () => {
    if (retry !== undefined) timers.clear(retry)
    retry = undefined
  }
  async function run(attempt: number): Promise<void> {
    if (disposed) return
    cancelRetry()
    const request = ++generation
    onLoading(true)
    try {
      const data = await load()
      if (disposed || request !== generation) return
      onData(data)
      onError(null)
    } catch (error) {
      if (disposed || request !== generation) return
      // Keep the last successful value for THIS workspace on transient failures.
      onError(error instanceof Error ? error.message : 'Failed to load workspace metadata')
      if (attempt < delays.length) {
        retry = timers.set(() => { void run(attempt + 1) }, delays[attempt]!)
      }
    } finally {
      if (!disposed && request === generation) onLoading(false)
    }
  }
  return {
    refresh: () => run(0),
    dispose: () => { disposed = true; generation++; cancelRetry() },
  }
}
