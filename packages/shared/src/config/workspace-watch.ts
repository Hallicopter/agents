import { watch, lstatSync, readdirSync, type FSWatcher } from 'node:fs'
import { join } from 'node:path'

const collections = ['sources', 'skills', 'sessions', 'pages']
/** Watch configuration directories, never arbitrary session data or source runtimes.
 * Nonrecursive watches also avoid following browser socket/profile symlinks. */
export function watchWorkspaceConfig(root: string, changed: (path: string, event: string) => void, failed: (error: unknown) => void): { close(): void } {
  const watchers = new Map<string, FSWatcher>()
  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const directory = (path: string) => { try { return lstatSync(path).isDirectory() } catch { return false } }
  const reconcile = () => {
    if (closed) return
    const wanted = new Set([''])
    for (const group of [...collections, 'statuses', 'labels']) {
      if (!directory(join(root, group))) continue
      wanted.add(group)
      if (collections.includes(group)) {
        for (const entry of readdirSync(join(root, group), { withFileTypes: true })) {
          if (entry.isDirectory()) wanted.add(`${group}/${entry.name}`)
        }
      }
    }
    if (directory(join(root, 'statuses/icons'))) wanted.add('statuses/icons')
    for (const [path, watcher] of watchers) if (!wanted.has(path)) { watcher.close(); watchers.delete(path) }
    for (const path of wanted) {
      if (watchers.has(path)) continue
      try {
        const watcher = watch(join(root, path), (event, filename) => {
          if (closed) return
          if (filename) changed(path ? `${path}/${filename}` : String(filename), event)
          if (event === 'rename') schedule()
        })
        watcher.on('error', error => { watcher.close(); watchers.delete(path); failed(error) })
        watchers.set(path, watcher)
      } catch (error) { failed(error) }
    }
  }
  const schedule = () => {
    if (timer || closed) return
    timer = setTimeout(() => { timer = undefined; try { reconcile() } catch (error) { failed(error) } }, 100)
  }
  try { reconcile() } catch (error) { failed(error) }
  return { close() { closed = true; if (timer) clearTimeout(timer); for (const watcher of watchers.values()) watcher.close(); watchers.clear() } }
}
