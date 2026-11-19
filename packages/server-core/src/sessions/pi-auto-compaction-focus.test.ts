import { expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { piAutoCompactionFocusForSession } from './pi-auto-compaction-focus'

it('enables automatic focus only for an exact Puck role on an interactive session', () => {
  expect(piAutoCompactionFocusForSession({ labels: ['project', 'puck'] })).toBe('puck')
  for (const labels of [undefined, [], ['Puck'], ['puck::true'], ['puck-other'], ['puck-subagent'],
    ['puck-automation'], ['puck', 'puck-subagent'], ['puck', 'puck-automation']]) {
    expect(piAutoCompactionFocusForSession({ labels })).toBeUndefined()
  }
  expect(piAutoCompactionFocusForSession({ labels: ['puck'], triggeredBy: { automationName: 'scheduled' } }))
    .toBeUndefined()
})

it('uses persisted spawn ancestry and automation provenance for the Pi backend focus gate', async () => {
  const home = mkdtempSync(join(tmpdir(), 'craft-puck-focus-'))
  try {
    const result = Bun.spawn([process.execPath, join(import.meta.dir, '../../tests/pi-auto-compaction-focus.fixture.ts')], {
      env: { PATH: process.env.PATH, HOME: home, CRAFT_CONFIG_DIR: home },
      stderr: 'pipe', stdout: 'pipe', timeout: 10_000,
    })
    const [code, stdout, stderr] = await Promise.all([
      result.exited, new Response(result.stdout).text(), new Response(result.stderr).text(),
    ])
    expect(code, `${stdout}\n${stderr}`).toBe(0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}, 15_000)
