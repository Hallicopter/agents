import { RfbClientGate } from './rfb-watch'

/** Explicit input-capable parser. Never substitute this for the default watch gate.
 * Only standard KeyEvent and PointerEvent are added; clipboard/extensions stay denied.
 */
export class ControlRfbGate extends RfbClientGate {
  private width = 0
  private height = 0
  constructor() { super(true) }
  setFramebufferSize(width: number, height: number): void {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192) throw new Error('Invalid control framebuffer')
    this.width = width; this.height = height
  }
  protected override validateInput(message: Buffer): void {
    if (!this.width || !this.height) throw new Error('Control framebuffer not ready')
    if (message[0] === 4) {
      if (message[1]! > 1 || message[2] !== 0 || message[3] !== 0 || message.readUInt32BE(4) === 0) throw new Error('Invalid key event')
    } else if (message[0] === 5) {
      if (message.readUInt16BE(2) >= this.width || message.readUInt16BE(4) >= this.height) throw new Error('Pointer outside framebuffer')
    } else throw new Error('Unsupported control event')
  }
}

/** Track only events admitted at the actual upstream write boundary, not parsed queues.
 * Synthesized releases must use the SAME authenticated RFB connection. A failed
 * connection cannot confirm cleanup: its arbiter must remain quarantined.
 */
export class RfbInputState {
  private readonly keys = new Set<number>()
  private buttons = 0
  private x = 0
  private y = 0
  record(message: Buffer): void {
    if (message[0] === 4) {
      const key = message.readUInt32BE(4)
      if (message[1] === 1) {
        if (!this.keys.has(key) && this.keys.size >= 64) throw new Error('Held key limit')
        this.keys.add(key)
      } else this.keys.delete(key)
    } else if (message[0] === 5) {
      this.buttons = message[1]!
      this.x = message.readUInt16BE(2); this.y = message.readUInt16BE(4)
    }
  }
  get held(): boolean { return this.keys.size > 0 || this.buttons !== 0 }
  releases(): Buffer[] {
    const output: Buffer[] = []
    for (const key of this.keys) {
      const message = Buffer.alloc(8); message[0] = 4; message.writeUInt32BE(key, 4); output.push(message)
    }
    if (this.buttons) {
      const message = Buffer.alloc(6); message[0] = 5; message.writeUInt16BE(this.x, 2); message.writeUInt16BE(this.y, 4); output.push(message)
    }
    return output
  }
  confirmReleased(): void { this.keys.clear(); this.buttons = 0 }
}
