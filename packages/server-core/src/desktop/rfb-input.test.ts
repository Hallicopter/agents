import { describe, expect, test } from 'bun:test'
import { ControlRfbGate, RfbInputState } from './rfb-input'
import { WatchRfbGate } from './rfb-watch'
const hello = Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.from([1, 1])])
const key = (down = true, value = 0x61) => { const b = Buffer.alloc(8); b[0] = 4; b[1] = down ? 1 : 0; b.writeUInt32BE(value, 4); return b }
const pointer = (buttons = 0, x = 10, y = 20) => { const b = Buffer.alloc(6); b[0] = 5; b[1] = buttons; b.writeUInt16BE(x, 2); b.writeUInt16BE(y, 4); return b }
const ready = () => { const gate = new ControlRfbGate(); gate.setFramebufferSize(1440, 900); gate.push(hello); return gate }
describe('explicit standard RFB control parser', () => {
  test('watch class cannot accept keys or pointer', () => { for (const b of [key(), pointer()]) { const gate = new WatchRfbGate(); gate.push(hello); expect(() => gate.push(b)).toThrow() } })
  test('fragmented/coalesced standard keys, modifiers, drag and wheel', () => {
    const gate = ready(); const k = key(true, 0xffe3); const p = pointer(1); const wheel = pointer(8)
    expect(gate.push(k.subarray(0, 3))).toEqual([])
    expect(gate.push(Buffer.concat([k.subarray(3), p, wheel, key(false, 0xffe3), pointer()]))).toEqual([k, p, wheel, key(false, 0xffe3), pointer()])
  })
  test('input requires actual framebuffer dimensions', () => { const gate = new ControlRfbGate(); gate.push(hello); expect(() => gate.push(key())).toThrow() })
  test('malformed key and out-of-bounds pointer poison stream', () => {
    const badDown = key(); badDown[1] = 2
    const padding = key(); padding[2] = 1
    for (const b of [badDown, padding, key(true, 0), pointer(1, 1440, 899), pointer(0, 1, 900)]) { const gate = ready(); expect(() => gate.push(b)).toThrow(); expect(() => gate.push(key())).toThrow() }
  })
  test('clipboard, file transfer, resize, fences and extended-key encodings stay denied', () => { for (const type of [1, 6, 7, 150, 248, 251, 255]) expect(() => ready().push(Buffer.from([type]))).toThrow() })
  test('oversized input fails before parsing or forwarding', () => { expect(() => ready().push(Buffer.alloc(65537))).toThrow() })
})
describe('actual-admission input state', () => {
  test('tracks only recorded events, repeats are deduplicated, releases preserve coordinates', () => {
    const state = new RfbInputState(); expect(state.releases()).toEqual([])
    state.record(key(true, 0xffe3)); state.record(key(true, 0x61)); state.record(key(true, 0x61)); state.record(pointer(1, 40, 50))
    expect(state.held).toBe(true); expect(state.releases()).toEqual([key(false, 0xffe3), key(false, 0x61), pointer(0, 40, 50)])
    // Building releases isn't an acknowledgement that cleanup reached the server.
    expect(state.held).toBe(true); state.confirmReleased(); expect(state.held).toBe(false)
  })
  test('normal ups and zero button mask remove held state', () => { const state = new RfbInputState(); state.record(key()); state.record(key(false)); state.record(pointer(8)); state.record(pointer()); expect(state.held).toBe(false) })
  test('bounded distinct held keys', () => { const state = new RfbInputState(); for (let i = 1; i <= 64; i++) state.record(key(true, i)); state.record(key(true, 1)); expect(() => state.record(key(true, 65))).toThrow(); state.record(key(false, 1)); state.record(key(true, 65)); expect(state.releases()).toHaveLength(64) })
})
