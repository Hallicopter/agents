import { createDesktopRuntime } from './desktop-runtime'

/** Desktop is optional. Failure must deny desktop access, not stop chat or messaging. */
export async function startDesktopRuntime(
  path: string | undefined,
  create: typeof createDesktopRuntime = createDesktopRuntime,
  warn: (message: string) => void = console.warn,
): Promise<ReturnType<typeof createDesktopRuntime>> {
  let runtime: ReturnType<typeof createDesktopRuntime> = undefined
  try {
    runtime = create(path)
    await runtime?.ready
    return runtime
  } catch {
    try { await runtime?.dispose() } catch { /* failed startup may also reject disposal */ }
    warn('[desktop] Optional desktop unavailable; chat and messaging will continue. Check desktop configuration and broker socket.')
    return undefined
  }
}
