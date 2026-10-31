import { describe, test, expect, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createAndroidApkDownload, ANDROID_APK_ROUTE, ANDROID_APK_SHA256, ANDROID_APK_SIZE } from './android-apk-download'

const dir = mkdtempSync(join(tmpdir(), 'apk-route-test-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('absent opt-in leaves existing listener unchanged', () => {
  expect(createAndroidApkDownload(undefined, false)).toBeUndefined()
})
test('requires native TLS and absolute operator path', () => {
  expect(() => createAndroidApkDownload('/missing', false)).toThrow()
  expect(() => createAndroidApkDownload('relative.apk', true)).toThrow()
})
test('rejects missing, directories, wrong size and hash; never accepts arbitrary content', () => {
  const wrong = join(dir, 'wrong.apk')
  writeFileSync(wrong, Buffer.alloc(ANDROID_APK_SIZE))
  expect(() => createAndroidApkDownload(wrong, true)).toThrow('verification')
  writeFileSync(wrong, 'small')
  expect(() => createAndroidApkDownload(wrong, true)).toThrow('verification')
  expect(() => createAndroidApkDownload(dir, true)).toThrow('verification')
  expect(() => createAndroidApkDownload(join(dir, 'missing'), true)).toThrow('verification')
})
test('refuses final symlink', () => {
  const target = join(dir, 'target.apk'); const link = join(dir, 'link.apk')
  writeFileSync(target, Buffer.alloc(ANDROID_APK_SIZE)); symlinkSync(target, link)
  expect(() => createAndroidApkDownload(link, true)).toThrow('verification')
})

// Positive route smoke tests use the independently built, exact hash-pinned APK.
// CI without that artifact still runs all startup rejection tests above.
const artifact = process.env.CRAFT_ANDROID_APK_TEST_PATH

describe.skipIf(!artifact)('verified APK transport boundary', () => {
  const handler = artifact ? createAndroidApkDownload(artifact, true)! : undefined!
  function request(overrides: {url?: string; method?: string; host?: string; encrypted?: boolean; local?: string; remote?: string; headers?: Record<string,string>; rawHeaders?: string[]} = {}) {
    const req = { url: overrides.url ?? ANDROID_APK_ROUTE, method: overrides.method ?? 'GET', headers: {host: overrides.host ?? 'vps.sturgeon-dab.ts.net:9100', ...overrides.headers}, rawHeaders: overrides.rawHeaders ?? ['Host', overrides.host ?? 'vps.sturgeon-dab.ts.net:9100'], socket: {encrypted: overrides.encrypted ?? true, localAddress: overrides.local ?? '100.64.0.1', remoteAddress: overrides.remote ?? '100.127.255.254'} } as unknown as IncomingMessage
    const headers: Record<string, unknown> = {}; let body: Buffer | undefined
    const res = {statusCode: 0, setHeader: (name: string, value: unknown) => { headers[name] = value }, end: (value?: Buffer) => {body = value}} as unknown as ServerResponse
    const handled = handler(req, res)
    return {handled, status: res.statusCode, headers, body}
  }
  test('GET exact verified bytes; HEAD headers only', () => {
    const get = request(); expect(get.handled).toBe(true); expect(get.status).toBe(200)
    expect(get.body?.length).toBe(ANDROID_APK_SIZE)
    expect(createHash('sha256').update(get.body!).digest('hex')).toBe(ANDROID_APK_SHA256)
    expect(get.headers['Content-Type']).toBe('application/vnd.android.package-archive')
    expect(get.headers['Cache-Control']).toBe('no-store')
    expect(get.headers['Content-Disposition']).toBe('attachment; filename="scoville-agents-debug.apk"')
    expect(get.headers['Set-Cookie']).toBeUndefined()
    const head = request({method: 'HEAD'}); expect(head.status).toBe(200); expect(head.body).toBeUndefined(); expect(head.headers['Content-Length']).toBe(ANDROID_APK_SIZE)
  })
  for (const url of ['/downloads','/downloads/','/downloads/../secret','/downloads/%2e%2e/secret', ANDROID_APK_ROUTE+'?token=x', ANDROID_APK_ROUTE+'/', '/downloads/other.apk']) {
    test(`no arbitrary route or query ${url}`, () => { const r = request({url}); expect(r.handled).toBe(true); expect(r.status).toBe(404); expect(r.body).toBeUndefined() })
  }
  for (const method of ['POST','PUT','DELETE','OPTIONS','TRACE']) {
    test(`rejects method ${method}`, () => { const r = request({method}); expect(r.status).toBe(405); expect(r.headers.Allow).toBe('GET, HEAD'); expect(r.body).toBeUndefined() })
  }
  for (const overrides of [{encrypted:false},{host:'evil.example:9100'},{host:'vps.sturgeon-dab.ts.net'}, {remote:'127.0.0.1'}, {local:'127.0.0.1'}, {remote:'203.0.113.1'}, {remote:'100.63.255.255'}, {remote:'100.128.0.0'}, {remote:'fd7a:115c:a1e1::1'}, {remote:'bad'}, {remote:'::ffff:fd7a:115c:a1e0::1'}, {remote:'fd7a:115c:a1e0::1%eth0'}, {host:'vps.sturgeon-dab.ts.net:9100,evil.example'}, {host:'vps.sturgeon-dab.ts.net:9100.'}, {remote:'203.0.113.1',headers:{'x-forwarded-for':'100.64.0.1','x-forwarded-proto':'https'}}]) {
    test(`rejects untrusted socket/host ${JSON.stringify(overrides)}`, () => { const r = request(overrides); expect(r.status).toBe(404); expect(r.body).toBeUndefined() })
  }
  for (const rawHeaders of [[], ['Host', 'vps.sturgeon-dab.ts.net:9100', 'hOsT', 'evil.example'], ['Host', 'evil.example', 'HOST', 'vps.sturgeon-dab.ts.net:9100'], ['Host', 'vps.sturgeon-dab.ts.net:9100', 'Host', 'vps.sturgeon-dab.ts.net:9100']]) {
    test(`rejects missing/duplicate raw Host ${JSON.stringify(rawHeaders)}`, () => {
      const r = request({rawHeaders}); expect(r.status).toBe(404); expect(r.body).toBeUndefined()
    })
  }
  test('accepts actual Tailscale IPv6 and mapped IPv4', () => {
    expect(request({local:'fd7a:115c:a1e0::1',remote:'fd7a:115c:a1e0:abcd::2'}).status).toBe(200)
    expect(request({local:'::ffff:100.64.0.1',remote:'::ffff:100.100.100.100'}).status).toBe(200)
  })
  test('unrelated authenticated backend routes remain untouched', () => {
    expect(request({url:'/api/sessions'}).handled).toBe(false)
    expect(request({url:'/login'}).handled).toBe(false)
  })
})
