import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeSessionJsonl } from '../jsonl'
import { listSessions } from '../storage'
import { SessionPersistenceQueue } from '../persistence-queue'
import type { StoredSession } from '../types'

let root: string
let file: string
let session: StoredSession
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'craft-atomic-save-'))
  fs.mkdirSync(join(root, 'sessions', 'test-session'), { recursive: true })
  file = join(root, 'sessions', 'test-session', 'session.jsonl')
  session = { id: 'test-session', workspaceRootPath: root, createdAt: 1, lastUsedAt: 1, messages: [], name: 'original', tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 }  }
  writeSessionJsonl(file, session)
})
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

it('listing preserves both active and orphaned temporary files', () => {
  for (const suffix of ['.tmp', '.writer.tmp']) fs.writeFileSync(file + suffix, 'recovery data')
  expect(listSessions(root).map(s => s.id)).toContain(session.id)
  for (const suffix of ['.tmp', '.writer.tmp']) expect(fs.readFileSync(file + suffix, 'utf8')).toBe('recovery data')
  fs.unlinkSync(file)
  listSessions(root)
  expect(fs.existsSync(file + '.tmp')).toBe(true)
})

it('sync replacement failure preserves the original and recoverable new copy', () => {
  const original = fs.readFileSync(file, 'utf8')
  let temp = ''
  const rename = spyOn(fs, 'renameSync').mockImplementation((from) => { temp = String(from); throw new Error('simulated rename failure') })
  try {
    expect(() => writeSessionJsonl(file, { ...session, name: 'new' })).toThrow('simulated rename failure')
    expect(fs.readFileSync(file, 'utf8')).toBe(original)
    expect(JSON.parse(fs.readFileSync(temp, 'utf8').split('\n')[0]!).name).toBe('new')
  } finally { rename.mockRestore() }
})

it('async replacement failure preserves the original session', async () => {
  const original = fs.readFileSync(file, 'utf8')
  const rename = spyOn(fsp, 'rename').mockRejectedValue(new Error('simulated rename failure'))
  const log = spyOn(console, 'error').mockImplementation(() => {})
  const queue = new SessionPersistenceQueue(60000)
  try {
    queue.enqueue({ ...session, name: 'new' })
    await queue.flush(session.id)
    expect(log).toHaveBeenCalled()
    expect(fs.readFileSync(file, 'utf8')).toBe(original)
  } finally { rename.mockRestore(); log.mockRestore() }
})

it('listing and a synchronous save cannot steal an async writer temporary file', async () => {
  const realRename = fsp.rename
  const temps: string[] = []
  const rename = spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
    temps.push(String(from))
    listSessions(root)
    writeSessionJsonl(file, { ...session, name: 'sync update' })
    expect(fs.existsSync(String(from))).toBe(true)
    await realRename(from, to)
  })
  const queue = new SessionPersistenceQueue(60000)
  try {
    queue.enqueue({ ...session, name: 'async update' })
    await queue.flush(session.id)
    expect(temps).toHaveLength(1)
    expect(JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]!).name).toBe('async update')
  } finally { rename.mockRestore() }
})

it('flushAll waits for a timer-started save and serializes its replacement', async () => {
  const realRename = fsp.rename
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const entered = new Promise<void>(resolve => { started = resolve })
  let calls = 0
  const rename = spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
    if (++calls === 1) { started(); await gate }
    await realRename(from, to)
  })
  const queue = new SessionPersistenceQueue(0)
  try {
    queue.enqueue({ ...session, name: 'timer write' })
    await entered
    queue.enqueue({ ...session, name: 'latest write' })
    let completed = false
    const flushed = queue.flushAll().then(() => { completed = true })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(completed).toBe(false)
    expect(calls).toBe(1)
    release()
    await flushed
    expect(calls).toBe(2)
    expect(JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]!).name).toBe('latest write')
  } finally { release(); await queue.flushAll(); rename.mockRestore() }
})
