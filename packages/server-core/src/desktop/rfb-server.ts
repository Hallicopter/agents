/** Server-to-viewer parser for the gateway's Raw-only RFB dialect.
 * Drops ServerCutText (including clipboard contents), rejects extensions, bounds memory.
 * Must start immediately AFTER ServerInit. Framebuffers are 32-bit true colour.
 */
export class RfbServerGate {
  protected constructor(private readonly allowFence: boolean) {}
  protected handleFence(_message: Buffer): void { throw new Error('Unsupported server message') }
  private pending = Buffer.alloc(0)
  private failed = false
  push(chunk: Buffer): Buffer[] {
    if (this.failed) throw new Error('RFB stream closed')
    try {
      if (this.pending.length + chunk.length > 16 * 1024 * 1024) throw new Error('Framebuffer limit')
      this.pending = Buffer.concat([this.pending, chunk])
      const output: Buffer[] = []
      while (this.pending.length) {
        const b = this.pending
        let size = 0
        if (b[0] === 0) {
          if (b.length < 4) break
          const rectangles = b.readUInt16BE(2)
          if (rectangles > 4096) throw new Error('Rectangle limit')
          size = 4
          let complete = true
          for (let i = 0; i < rectangles; i++) {
            if (b.length < size + 12) { complete = false; break }
            if (b.readInt32BE(size + 8) !== 0) throw new Error('Unsupported server encoding')
            const pixels = b.readUInt16BE(size + 4) * b.readUInt16BE(size + 6) * 4
            size += 12 + pixels
            if (size > 16 * 1024 * 1024) throw new Error('Framebuffer limit')
            if (b.length < size) { complete = false; break }
          }
          if (!complete) break
        } else if (b[0] === 2) size = 1 // Bell is harmless
        else if (b[0] === 3) {
          if (b.length < 8) break
          const length = b.readUInt32BE(4)
          if (length > 65536) throw new Error('Clipboard limit')
          size = 8 + length
          if (b.length < size) break
        } else if (b[0] === 248 && this.allowFence) {
          if (b.length < 9) break
          if (b[8]! > 64) throw new Error('Fence payload limit')
          size = 9 + b[8]!
          if (b.length < size) break
          this.handleFence(Buffer.from(b.subarray(0, size)))
        } else throw new Error('Unsupported server message')
        if (b[0] !== 3 && b[0] !== 248) output.push(Buffer.from(b.subarray(0, size)))
        this.pending = b.subarray(size)
      }
      return output
    } catch (error) { this.failed = true; this.pending = Buffer.alloc(0); throw error }
  }
}

/** Default watch dialect never negotiates or accepts Fence/extensions. */
export class WatchServerGate extends RfbServerGate {
  constructor() { super(false) }
}
