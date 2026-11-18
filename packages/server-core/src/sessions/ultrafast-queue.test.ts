import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('same-bearer replacement rejects queued and later sends; restart cannot restore consent', () => {
  const home = mkdtempSync(join(tmpdir(), 'craft-ultra-fixture-'))
  try {
    const result = Bun.spawnSync([process.execPath, join(import.meta.dir, '../../tests/ultrafast-queue.fixture.ts')], {
      env: { PATH: process.env.PATH, HOME: home, CRAFT_CONFIG_DIR: home }, timeout: 10000,
    })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// Historical-source integration needs both local git objects (not present in shallow CI archives).
const historicalSources = ['b1a5d0b3742aa35b8551fa828c92cab2d89692cd', 'd311e9de9ba7da08e314844cceaf3e9f3561398b']
const hasHistory = historicalSources.every(rev => Bun.spawnSync(['git', 'cat-file', '-e', `${rev}^{commit}`], { cwd: import.meta.dir, env: { PATH: process.env.PATH, GIT_NO_LAZY_FETCH: '1' } }).exitCode === 0)
test.skipIf(!hasHistory)('legacy desktop picker selects the status-list alias via the real session RPC', () => {
  const home = mkdtempSync(join(tmpdir(), 'craft-ultra-fixture-'))
  try {
    const result = Bun.spawnSync([process.execPath, join(import.meta.dir, '../../tests/ultrafast-legacy.fixture.ts')], {
      env: { PATH: process.env.PATH, HOME: home, CRAFT_CONFIG_DIR: home }, timeout: 20000,
    })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
  } finally { rmSync(home, { recursive: true, force: true }) }
}, 25000)
