import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDesktopRuntime } from './desktop-startup'

test('invalid optional desktop config does not prevent core server startup', async () => {
  const warnings: string[] = []
  expect(await startDesktopRuntime('/nonexistent/desktop-config.json', undefined, message => warnings.push(message))).toBeUndefined()
  expect(warnings).toHaveLength(1)
})
test('occupied broker path disables desktop without deleting paths or resetting input journal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-startup-'))
  const socket = join(dir, 'input.sock'), journal = join(dir, 'journal.json'), config = join(dir, 'config.json')
  try {
    writeFileSync(socket, 'preserve occupied path', { mode: 0o600 })
    writeFileSync(journal, '{"version":1,"dirty":true}', { mode: 0o600 })
    writeFileSync(`${config}.revoked`, '', { mode: 0o600 })
    writeFileSync(config, JSON.stringify({origin:'https://desktop.example.test', upstream:{host:'127.0.0.1',port:5902,passwordFile:join(dir,'unused')},entitlements:[],control:{socketPath:socket,journalPath:journal,ownerFile:join(dir,'unused-owner'),proxyPath:'/nonexistent/proxy',drainHelper:'/usr/bin/true'}}), {mode:0o600})
    const warnings: string[] = []
    expect(await startDesktopRuntime(config, undefined, message => warnings.push(message))).toBeUndefined()
    expect(warnings).toHaveLength(1)
    expect(existsSync(socket)).toBe(true)
    expect(readFileSync(socket,'utf8')).toBe('preserve occupied path')
    expect(JSON.parse(readFileSync(journal,'utf8')).dirty).toBe(true)
  } finally { rmSync(dir, {recursive:true,force:true}) }
})
test('unconfigured desktop stays absent without warnings', async () => {
  expect(await startDesktopRuntime(undefined, undefined, () => { throw Error('Unexpected warning') })).toBeUndefined()
})
