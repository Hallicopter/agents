/** RFB 3.8 downstream state machine. Only complete validated messages leave this gate.
 * Never attach this parser to a stream mid-handshake. Unknown extensions fail closed.
 */
export class RfbClientGate {
  protected constructor(private readonly allowInput: boolean) {}
  protected validateInput(_message: Buffer): void { throw new Error('Read-only RFB violation') }
  private pending = Buffer.alloc(0)
  private phase: 'version' | 'security' | 'init' | 'normal' = 'version'
  private failed = false
  push(chunk: Uint8Array): Buffer[] {
    if (this.failed) throw new Error('RFB stream closed')
    try {
      if (this.pending.length + chunk.length > 65536) throw new Error('RFB limit')
      this.pending = Buffer.concat([this.pending, chunk])
      const output: Buffer[] = []
      while (this.pending.length) {
        const b = this.pending
        let size: number
        if (this.phase === 'version') size = 12
        else if (this.phase === 'security' || this.phase === 'init') size = 1
        else {
          switch (b[0]) {
            case 0: size = 20; break // SetPixelFormat
            case 2:
              if (b.length < 4) return output
              if (b.readUInt16BE(2) > 64) throw new Error('RFB encoding limit')
              size = 4 + 4 * b.readUInt16BE(2); break
            case 3: size = 10; break // FramebufferUpdateRequest
            case 4:
              if (!this.allowInput) throw new Error('Read-only RFB violation')
              size = 8; break // Standard KeyEvent only
            case 5:
              if (!this.allowInput) throw new Error('Read-only RFB violation')
              size = 6; break // Standard PointerEvent (including wheel masks)
            default: throw new Error('Read-only RFB violation')
          }
        }
        if (b.length < size) break
        const msg = Buffer.from(b.subarray(0, size))
        if (this.phase === 'version') {
          if (msg.toString() !== 'RFB 003.008\n') throw new Error('RFB version')
          this.phase = 'security'
        } else if (this.phase === 'security') {
          if (msg[0] !== 1) throw new Error('RFB security')
          this.phase = 'init'
        } else if (this.phase === 'init') {
          if (msg[0] !== 1) throw new Error('Shared viewer required')
          this.phase = 'normal'
        } else if (msg[0] === 0) {
          // Restrict to standard true-colour 32-bit little-endian RGB. No exotic formats.
          if (msg[4] !== 32 || msg[5] !== 24 || msg[6] !== 0 || msg[7] !== 1 ||
              msg.readUInt16BE(8) !== 255 || msg.readUInt16BE(10) !== 255 ||
              msg.readUInt16BE(12) !== 255 || msg[14] !== 0 || msg[15] !== 8 || msg[16] !== 16)
            throw new Error('Unsupported pixel format')
        } else if (msg[0] === 2) {
          // Rewrite capabilities to Raw only. No clipboard, resize, continuous updates,
          // fence, file-transfer or vendor pseudo-encoding negotiation reaches upstream.
          output.push(Buffer.from([2, 0, 0, 1, 0, 0, 0, 0]))
          this.pending = b.subarray(size)
          continue
        } else if (msg[0] === 4 || msg[0] === 5) {
          this.validateInput(msg)
        } else if (msg[0] === 3 && (msg[1] > 1 || msg.readUInt16BE(6) === 0 || msg.readUInt16BE(8) === 0)) {
          throw new Error('Invalid framebuffer request')
        }
        output.push(msg)
        this.pending = b.subarray(size)
      }
      return output
    } catch (error) {
      this.failed = true
      this.pending = Buffer.alloc(0)
      throw error
    }
  }
}

/** Default, non-input gate: construction cannot opt this class into control. */
export class WatchRfbGate extends RfbClientGate {
  constructor() { super(false) }
}
