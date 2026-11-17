import { expect, test } from 'bun:test'
import type { Session } from '@craft-agent/shared/protocol'
import { openInventory } from '../../../../../apps/electron/src/renderer/lib/session-inventory'
import { INVENTORY_BYTES, inventoryPages } from './session-inventory'

function row(id: string, preview = 'x'.repeat(1500)): Session {
  return { id, workspaceId: 'workspace', workspaceName: 'workspace', lastMessageAt: 1, preview, messages: [], isProcessing: false }
}

test('27,951 rows: bounded first paint work and wire; following pages are pulled, not pushed', async () => {
  const ids = Array.from({ length: 27_951 }, (_, i) => `s${i}`)
  let projected = 0, calls = 0, bytes = 0
  const pages = inventoryPages(ids, id => { projected++; return row(id) })
  const read = openInventory([], async () => {
    calls++
    const page = pages.next(), value = { ...page.value, next: page.done ? null : `${calls}` }
    bytes = Buffer.byteLength(JSON.stringify(value)); expect(bytes).toBeLessThan(INVENTORY_BYTES + 1024)
    return value
  })
  const first = await read()
  expect(first.sessions.length).toBeGreaterThan(0)
  expect(first.more).toBe(true); expect(projected).toBeLessThanOrEqual(101)
  expect(calls).toBe(1)
  // Simulated 128 kbit/s useful throughput, 281 ms RTT. Not a live client measurement.
  expect((bytes + 4096) / 16_000 + 2 * 0.281).toBeLessThan(30)
  const result = first.sessions.map(s => s.id)
  while (result.length < ids.length) { const page = await read(); result.push(...page.sessions.map(s => s.id)); if (!page.more) break }
  expect(result).toEqual(ids)
})

test('giant multibyte and escaped row is lossless across bounded frames; deleted rows skipped', async () => {
  const big = row('big', '🪶\u0000"'.repeat(90_000))
  const pages = inventoryPages(['big', 'gone', 'next'], id => id === 'big' ? big : id === 'gone' ? null : row(id))
  const read = openInventory([], async () => {
    const page = pages.next(), value = { ...page.value, next: page.done ? null : 'next' }
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(INVENTORY_BYTES + 1024)
    return value
  })
  const all: Session[] = []; let more = true
  while (more) { const p = await read(); all.push(...p.sessions); more = p.more }
  expect(all).toEqual([big, row('next')])
})

test('older server response is complete without a follow-up', async () => {
  expect(await openInventory([], async () => [row('legacy')])()).toEqual({ sessions: [row('legacy')], more: false })
})
