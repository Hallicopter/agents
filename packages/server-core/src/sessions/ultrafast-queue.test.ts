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
