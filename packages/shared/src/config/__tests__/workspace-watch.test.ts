import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { watchWorkspaceConfig } from '../workspace-watch'

test('watches metadata and new sessions without traversing browser data', async () => {
  const root = mkdtempSync(join(tmpdir(), 'craft-watch-'))
  mkdirSync(join(root, 'sessions/one/data/browser'), { recursive: true })
  symlinkSync('/nonexistent/chrome-socket', join(root, 'sessions/one/data/browser/SingletonSocket'))
  const events: string[] = []; const errors: unknown[] = []
  const watcher = watchWorkspaceConfig(root, path => events.push(path), error => errors.push(error))
  try {
    writeFileSync(join(root, 'sessions/one/session.jsonl'), '{}')
    writeFileSync(join(root, 'sessions/one/data/browser/file'), 'unwatched')
    mkdirSync(join(root, 'sessions/two'))
    await new Promise(resolve => setTimeout(resolve, 250))
    writeFileSync(join(root, 'sessions/two/session.jsonl'), '{}')
    await new Promise(resolve => setTimeout(resolve, 250))
    expect(events).toContain('sessions/one/session.jsonl')
    expect(events).toContain('sessions/two/session.jsonl')
    expect(events.some(path => path.includes('data/browser'))).toBe(false)
    expect(errors).toEqual([])
  } finally { watcher.close(); rmSync(root, { recursive: true, force: true }) }
})
