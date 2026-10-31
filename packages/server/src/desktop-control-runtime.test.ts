import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDesktopControlRuntime } from './desktop-control-runtime'

test('host control keeps dirty state across restart and requires explicit admission', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sc-'))
  const journal = join(dir, 'journal'); const owner = join(dir, 'owner')
  writeFileSync(journal, '{"version":1,"dirty":false}', { mode: 0o600 })
  writeFileSync(owner, '{"owner":null}', { mode: 0o600 })
  const config = { journalPath: journal, ownerFile: owner, socketPath: join(dir, 'sock'), proxyPath: '/nonexistent/scoville-proxy', drainHelper: '/usr/bin/true' }
  const scope = { workspaceId: 'ws', sessionId: 'session' }
  const runtime = createDesktopControlRuntime(config, () => true, () => Date.now() + 10000)
  try {
    await runtime.ready
    expect(() => runtime.control.arbiter.acquireHuman({ ...scope, connectionId: 'c' }, Date.now() + 10000)).toThrow()
    expect(await runtime.control.authorizeRpc({ workspaceId: 'wrong' } as any, scope)).toBe(false)
    expect(await runtime.control.authorizeRpc({ workspaceId: 'ws' } as any, scope)).toBe(true)
    const lease = runtime.control.arbiter.acquireHuman({ ...scope, connectionId: 'c' }, Date.now() + 10000)
    expect(JSON.parse(readFileSync(journal, 'utf8')).dirty).toBe(true)
    expect(() => runtime.control.arbiter.beginAgent('op')).toThrow()
    await expect(runtime.control.confirmInputDrained(scope)).rejects.toThrow('not confirmed')
    runtime.control.arbiter.beginRelease(lease)
    expect(() => runtime.control.arbiter.finishRelease(lease, false)).toThrow()
  } finally { await runtime.dispose() }
  const restarted = createDesktopControlRuntime(config, () => true, () => Date.now() + 10000)
  try { await restarted.ready; expect(restarted.control.arbiter.state.phase).toBe('quarantine') }
  finally { await restarted.dispose(); rmSync(dir, { recursive: true, force: true }) }
})
