import { describe, expect, test } from 'bun:test'
import { ControlServerGate, controlEncodings, fencePacket, RfbFenceBarrier } from './rfb-fence'
import { WatchServerGate } from './rfb-server'

describe('gateway-owned Fence synchronization', () => {
  test('capability list is Raw and internal Fence only', () => { const b = controlEncodings(); expect(b.readUInt16BE(2)).toBe(2); expect(b.readInt32BE(4)).toBe(0); expect(b.readInt32BE(8)).toBe(-312) })
  test('only exact unpredictable nonce with Request clear and BlockBefore retained acknowledges', async () => {
    const written: Buffer[] = []; const barrier = new RfbFenceBarrier(b => written.push(b)); let done = false
    const pending = barrier.wait().then(() => { done = true }); const nonce = written[0]!.subarray(9)
    barrier.receive(fencePacket(1, Buffer.alloc(32))); await Promise.resolve(); expect(done).toBe(false)
    barrier.receive(fencePacket(0x80000001, nonce)); await Promise.resolve(); expect(done).toBe(false)
    expect(written[1]!.readUInt32BE(4)).toBe(0)
    barrier.receive(fencePacket(1, nonce)); await pending; expect(done).toBe(true)
  })
  test('cleared or unsupported response flags fail closed', async () => { for (const flags of [0, 2, 5, 9]) { let packet!: Buffer; const barrier = new RfbFenceBarrier(b => { packet = b }); const pending = barrier.wait(); barrier.receive(fencePacket(flags, packet.subarray(9))); await expect(pending).rejects.toThrow() } })
  test('server request reply promises no unsupported SyncNext/client-paint ordering', () => { const out: Buffer[] = []; const barrier = new RfbFenceBarrier(b => out.push(b)); barrier.receive(fencePacket(0x80000007, Buffer.from('test'))); expect(out).toEqual([fencePacket(0, Buffer.from('test'))]) })
  test('timeout, lost socket and ambiguous write reject instead of confirming release', async () => {
    const timeout = new RfbFenceBarrier(() => {}); await expect(timeout.wait(5)).rejects.toThrow()
    const lost = new RfbFenceBarrier(() => {}); const p = lost.wait(); lost.fail(); await expect(p).rejects.toThrow()
    const write = new RfbFenceBarrier(() => { throw new Error() }); await expect(write.wait()).rejects.toThrow()
  })
  test('outstanding barrier cannot be silently replaced or reused after completion', async () => {
    const out: Buffer[] = []; const barrier = new RfbFenceBarrier(b => out.push(b)); const first = barrier.wait()
    await expect(barrier.wait()).rejects.toThrow(); const oldNonce = out[0]!.subarray(9); barrier.receive(fencePacket(1, oldNonce)); await first
    const second = barrier.wait(); expect(out[1]!.subarray(9).equals(oldNonce)).toBe(false)
    barrier.receive(fencePacket(1, oldNonce)); barrier.fail(); await expect(second).rejects.toThrow()
  })
  test('fragmented/coalesced fences consumed internally; watch rejects them', () => {
    const fences: Buffer[] = []; const gate = new ControlServerGate(b => fences.push(b)); const message = fencePacket(1, Buffer.from('nonce'))
    expect(gate.push(message.subarray(0, 7))).toEqual([]); expect(gate.push(Buffer.concat([message.subarray(7), Buffer.from([2])]))).toEqual([Buffer.from([2])]); expect(fences).toEqual([message])
    expect(() => new WatchServerGate().push(message)).toThrow()
  })
  test('malformed padding, payload and message sizes are denied', () => {
    expect(() => fencePacket(0, Buffer.alloc(65))).toThrow(); const barrier = new RfbFenceBarrier(() => {})
    const padding = fencePacket(1, Buffer.alloc(0)); padding[1] = 1
    for (const b of [Buffer.alloc(8), padding, Buffer.from([248,0,0,0,0,0,0,1,65])]) expect(() => barrier.receive(b)).toThrow()
    expect(() => new ControlServerGate(() => {}).push(Buffer.from([248,0,0,0,0,0,0,1,65]))).toThrow()
  })
})

for (const mode of ['watch', 'control'] as const) test(`${mode} accepts fragmented tiled screen updates after scrolling`, () => {
  const fences: Buffer[] = []
  const gate = mode === 'watch' ? new WatchServerGate() : new ControlServerGate(b => fences.push(b))
  const count = 600, pixels = 32 * 32 * 4
  const frame = Buffer.alloc(4 + count * (12 + pixels))
  frame.writeUInt16BE(count, 2)
  for (let i = 0; i < count; i++) {
    const offset = 4 + i * (12 + pixels)
    frame.writeUInt16BE((i % 30) * 32, offset)
    frame.writeUInt16BE(Math.floor(i / 30) * 32, offset + 2)
    frame.writeUInt16BE(32, offset + 4); frame.writeUInt16BE(32, offset + 6)
  }
  const output: Buffer[] = []
  for (let offset = 0; offset < frame.length; offset += 16384) output.push(...gate.push(frame.subarray(offset, offset + 16384)))
  expect(output).toEqual([frame])
  if (mode === 'control') {
    expect(gate.push(fencePacket(1, Buffer.from('release')))).toEqual([])
    expect(fences).toHaveLength(1)
  }
  expect(gate.push(Buffer.from([2]))).toEqual([Buffer.from([2])])
})
test('tiled updates remain bounded by rectangle count and total frame size', () => {
  const tooMany = Buffer.alloc(4); tooMany.writeUInt16BE(4097, 2)
  expect(() => new WatchServerGate().push(tooMany)).toThrow('Rectangle limit')
  const huge = Buffer.alloc(16); huge.writeUInt16BE(1, 2); huge.writeUInt16BE(4096, 8); huge.writeUInt16BE(4096, 10)
  expect(() => new WatchServerGate().push(huge)).toThrow('Framebuffer limit')
})
