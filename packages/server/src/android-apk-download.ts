import { constants, closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { isIP } from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'

// Deliberately one reviewed, credential-free artifact, not a static-file server.
export const ANDROID_APK_ROUTE = '/downloads/scoville-agents-debug.apk'
export const ANDROID_APK_SHA256 = 'b2c5df8299d746d774026d1886d9598dc75ec0bb8ae729ff7a575bb60d3c7d16'
export const ANDROID_APK_SIZE = 37267
const HOST = 'vps.sturgeon-dab.ts.net:9100'

function tailnetAddress(address: string | undefined): boolean {
  if (!address) return false
  let ip = address.toLowerCase()
  if (ip.includes('%') || isIP(ip) === 0) return false
  if (ip.startsWith('::ffff:')) {
    ip = ip.slice('::ffff:'.length)
    if (isIP(ip) !== 4) return false
  }
  if (isIP(ip) === 4) {
    const parts = ip.split('.').map(Number)
    return parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127
  }
  return isIP(ip) === 6 && ip.startsWith('fd7a:115c:a1e0:')
}

/** Opt-in at startup; immutable bytes are descriptor-read, bounded and hash-pinned.
 * Requires native TLS and actual tailnet socket endpoints, never proxy headers.
 * Returns true only when the reserved download namespace was handled.
 */
export function createAndroidApkDownload(path: string | undefined, tlsEnabled: boolean):
  ((req: IncomingMessage, res: ServerResponse) => boolean) | undefined {
  if (!path) return undefined
  if (!tlsEnabled || !isAbsolute(path)) throw new Error('APK delivery requires native TLS and an absolute artifact path')
  let fd: number | undefined
  let bytes: Buffer
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size !== ANDROID_APK_SIZE) throw new Error('Invalid APK artifact')
    const buffer = Buffer.alloc(ANDROID_APK_SIZE + 1)
    let length = 0
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null)
      if (!count) break
      length += count
    }
    if (length !== ANDROID_APK_SIZE || createHash('sha256').update(buffer.subarray(0, length)).digest('hex') !== ANDROID_APK_SHA256) {
      throw new Error('Invalid APK artifact')
    }
    bytes = buffer.subarray(0, length)
  } catch {
    throw new Error('APK delivery artifact failed fixed size/hash verification')
  } finally {
    if (fd !== undefined) closeSync(fd)
  }

  return (req, res) => {
    const url = req.url ?? ''
    if (url !== '/downloads' && !url.startsWith('/downloads/')) return false
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    const encrypted = (req.socket as typeof req.socket & { encrypted?: boolean }).encrypted === true
    const rawHosts: string[] = []
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (req.rawHeaders[i]?.toLowerCase() === 'host') rawHosts.push(req.rawHeaders[i + 1] ?? '')
    }
    if (url !== ANDROID_APK_ROUTE || !encrypted || req.headers.host !== HOST ||
        rawHosts.length !== 1 || rawHosts[0] !== HOST ||
        !tailnetAddress(req.socket.localAddress) || !tailnetAddress(req.socket.remoteAddress)) {
      res.statusCode = 404
      res.end()
      return true
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405
      res.setHeader('Allow', 'GET, HEAD')
      res.end()
      return true
    }
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/vnd.android.package-archive')
    res.setHeader('Content-Disposition', 'attachment; filename="scoville-agents-debug.apk"')
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
    res.setHeader('Content-Length', bytes.length)
    res.setHeader('ETag', `"sha256-${ANDROID_APK_SHA256}"`)
    res.end(req.method === 'HEAD' ? undefined : bytes)
    return true
  }
}
