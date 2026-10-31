import { randomBytes, timingSafeEqual } from 'node:crypto'
import { RfbServerGate } from './rfb-server'
export const FENCE_ENCODING = -312
const REQUEST = 0x80000000
const BLOCK_BEFORE = 1

/** Gateway-owned capability list. Renderer Fence/extensions remain denied. */
export function controlEncodings(): Buffer {
  const message = Buffer.alloc(12); message[0] = 2; message.writeUInt16BE(2, 2)
  message.writeInt32BE(0, 4); message.writeInt32BE(FENCE_ENCODING, 8); return message
}
export function fencePacket(flags: number, payload: Buffer): Buffer {
  if (payload.length > 64) throw new Error('Fence payload limit')
  const message = Buffer.alloc(9 + payload.length); message[0] = 248
  message.writeUInt32BE(flags >>> 0, 4); message[8] = payload.length; payload.copy(message, 9); return message
}

/** Single outstanding unpredictable synchronization barrier per connection.
 * Kernel writes/frame updates/announcements are NEVER release acknowledgments.
 * A response retaining BlockBefore guarantees preceding input took effect under
 * the negotiated RFB Fence contract, not arbitrary remote app completion.
 */
export class RfbFenceBarrier {
  private pending: { nonce: Buffer; resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | undefined
  constructor(private readonly write: (message: Buffer) => void) {}
  wait(timeoutMs = 2000): Promise<void> {
    if (this.pending) return Promise.reject(new Error('Fence already pending'))
    return new Promise((resolve, reject) => {
      const nonce = randomBytes(32)
      const timer = setTimeout(() => { this.fail(); reject(new Error('Fence acknowledgment timeout')) }, timeoutMs)
      this.pending = { nonce, resolve, reject, timer }
      try { this.write(fencePacket(REQUEST | BLOCK_BEFORE, nonce)) } catch { this.fail() }
    })
  }
  receive(message: Buffer): void {
    if (message.length < 9 || message[0] !== 248 || message[1] || message[2] || message[3] || message[8]! > 64 || message.length !== 9 + message[8]!) throw new Error('Invalid server Fence')
    const flags = message.readUInt32BE(4)
    const payload = message.subarray(9)
    if (flags & REQUEST) {
      // Do not advertise renderer synchronization semantics we cannot provide.
      // Clear SyncNext/BlockBefore/BlockAfter and all unknown bits in this reply.
      this.write(fencePacket(0, payload)); return
    }
    const pending = this.pending
    if (!pending || payload.length !== pending.nonce.length || !timingSafeEqual(payload, pending.nonce)) return
    if (!(flags & BLOCK_BEFORE) || (flags & ~BLOCK_BEFORE) !== 0) { this.fail(); return }
    this.pending = undefined; clearTimeout(pending.timer); pending.resolve()
  }
  fail(): void {
    const pending = this.pending; this.pending = undefined
    if (pending) { clearTimeout(pending.timer); pending.reject(new Error('Fence not confirmed')) }
  }
}

/** Fence messages are consumed internally and never reach the noVNC renderer. */
export class ControlServerGate extends RfbServerGate {
  constructor(private readonly onFence: (message: Buffer) => void) { super(true) }
  protected override handleFence(message: Buffer): void { this.onFence(message) }
}
