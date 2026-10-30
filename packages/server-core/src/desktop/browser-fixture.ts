/** Manual reproducible real-browser fixture. No live credentials/config or desktop access.
 * bun packages/server-core/src/desktop/browser-fixture.ts /absolute/artifact-directory
 * Requires local google-chrome + openssl. Listeners bind ONLY 127.0.0.1, then close.
 */
import { createServer as createTcpServer } from 'node:net'
import { createServer as createHttpsServer } from 'node:https'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync, spawn } from 'node:child_process'
import { WebSocket } from 'ws'
import { DesktopGateway } from './gateway'
// @ts-expect-error noVNC has no declarations
import { DESECBCipher } from '@novnc/novnc/lib/crypto/des.js'

const output = resolve(process.argv[2] ?? '/tmp/craft-desktop-fixture')
mkdirSync(output, { recursive: true })
const temp = mkdtempSync(join(tmpdir(), 'craft-desktop-fixture-'))
let gateway: DesktopGateway | undefined
const tcpSockets = new Set<import('node:net').Socket>()
let browser: ReturnType<typeof spawn> | undefined
let rendered = false
let inputMessages = 0
const challenge = Buffer.from('0123456789abcdef')
const tcp = createTcpServer(socket => {
  tcpSockets.add(socket); socket.on('close', () => tcpSockets.delete(socket))
  socket.on('error', () => {})
  socket.write('RFB 003.008\n')
  let state = 0
  let pending = Buffer.alloc(0)
  socket.on('data', data => {
    pending = Buffer.concat([pending, data])
    while (pending.length) {
      const size = state === 0 ? 12 : state === 1 ? 1 : state === 2 ? 16 : state === 3 ? 1 : pending[0] === 0 ? 20 : pending[0] === 2 ? (pending.length < 4 ? 4 : 4 + pending.readUInt16BE(2) * 4) : pending[0] === 3 ? 10 : 1
      if (pending.length < size) return
      const packet = pending.subarray(0, size); pending = pending.subarray(size)
      if (state === 0) { if (packet.toString() !== 'RFB 003.008\n') throw new Error('version'); socket.write(Buffer.from([1, 2])); state++ }
      else if (state === 1) { if (packet[0] !== 2) throw new Error('security'); socket.write(challenge); state++ }
      else if (state === 2) {
        const key = new Uint8Array(8); key.set(Buffer.from('fixture'))
        if (!packet.equals(Buffer.from(DESECBCipher.importKey(key).encrypt({}, challenge)))) throw new Error('challenge')
        socket.write(Buffer.alloc(4)); state++
      } else if (state === 3) {
        if (packet[0] !== 1) throw new Error('nonshared init')
        const init = Buffer.alloc(24); init.writeUInt16BE(640, 0); init.writeUInt16BE(360, 2)
        init.set([32,24,0,1,0,255,0,255,0,255,0,8,16], 4)
        socket.write(init); state++
      } else if (packet[0] === 3) {
        const frame = Buffer.alloc(16 + 640 * 360 * 4)
        frame[3] = 1; frame.writeUInt16BE(640, 8); frame.writeUInt16BE(360, 10)
        for (let y = 0; y < 360; y++) for (let x = 0; x < 640; x++) {
          const at = 16 + (y * 640 + x) * 4
          frame[at] = x < 320 ? 40 : 80; frame[at + 1] = y < 180 ? 160 : 80; frame[at + 2] = 220
        }
        socket.write(frame)
      } else if (packet[0] !== 0 && packet[0] !== 2) { inputMessages++; throw new Error('input reached fixture') }
    }
  })
})
let origin = ''
const cert = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(temp, 'key.pem'), '-out', join(temp, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost'])
if (cert.status !== 0) throw new Error('Unable to generate disposable localhost certificate')
const bundle = await Bun.build({ entrypoints: [join(import.meta.dir, '../../../../apps/electron/src/renderer/components/desktop/browser-fixture-client.ts')], target: 'browser', format: 'esm' })
if (!bundle.success) throw new Error('Fixture bundle failed')
const javascript = await bundle.outputs[0]!.text()
const https = createHttpsServer({ key: readFileSync(join(temp, 'key.pem')), cert: readFileSync(join(temp, 'cert.pem')) }, (req, res) => {
  if (req.url?.startsWith('/fixture-error')) { console.error(req.url); res.end('ok') }
  else if (req.url === '/fixture.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(javascript) }
  else if (req.url === '/fixture-grant') {
    void gateway!.issueRpcGrant({ clientId: 'fixture', workspaceId: 'fixture', webContentsId: null }, 'fixture', origin, () => true)
      .then(grant => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(grant)) })
  } else if (req.url === '/fixture-rendered') { rendered = true; res.end('ok') }
  else { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html><head><meta charset="utf-8"><script>window.onerror=(m)=>fetch("/fixture-error?m="+encodeURIComponent(m));window.onunhandledrejection=(e)=>fetch("/fixture-error?m="+encodeURIComponent(String(e.reason)))</script><title>Craft Desktop — isolated test</title><style>body{background:#17191d;color:#e9edf2;font:16px system-ui;margin:40px}h1{font-size:24px}p{color:#aab5c1}#screen{width:960px;height:540px;background:#000;border-radius:12px;overflow:hidden}#status{color:#79d7a0}</style></head><body><h1>Desktop <small>· Watch only</small></h1><p>Actual bundled noVNC → private gateway → disposable RFB fixture. No live desktop/profile.</p><div id="screen"></div><p id="status">Connecting…</p><script type="module" src="/fixture.js"></script></body></html>') }
})
try {
  tcp.listen(0, '127.0.0.1'); await once(tcp, 'listening')
  https.listen(0, '127.0.0.1'); await once(https, 'listening')
  origin = `https://127.0.0.1:${(https.address() as { port: number }).port}`
  gateway = new DesktopGateway({ origin, upstream: { host: '127.0.0.1', port: (tcp.address() as { port: number }).port, password: async () => 'fixture' }, authorize: async () => false, authorizeRpc: async (_, scope) => scope.workspaceId === 'fixture' && scope.sessionId === 'fixture' })
  https.on('upgrade', (req, socket, head) => gateway!.upgrade(req, socket, head))
  // Certificate bypass is restricted to this disposable localhost test process.
  browser = spawn('google-chrome', ['--headless', '--no-sandbox', '--disable-gpu', '--ignore-certificate-errors', `--user-data-dir=${join(temp, 'chrome')}`, '--window-size=1100,800', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] })
  const endpoint = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chrome startup timeout')), 10000)
    browser!.stderr!.on('data', data => { const match = data.toString().match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]) } })
  })
  const cdp = new WebSocket(endpoint)
  await once(cdp, 'open')
  let id = 0
  const pending = new Map<number, (result: any) => void>()
  cdp.on('message', raw => { const message = JSON.parse(raw.toString()); if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id) } })
  const command = (method: string, params: object = {}, sessionId?: string): Promise<any> => new Promise((resolve, reject) => {
    const key = ++id
    const timer = setTimeout(() => { pending.delete(key); reject(new Error(`CDP timeout: ${method}`)) }, 15000)
    pending.set(key, message => { clearTimeout(timer); message.error ? reject(new Error(message.error.message)) : resolve(message.result) })
    cdp.send(JSON.stringify({ id: key, method, params, sessionId }))
  })
  const { targetId } = await command('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true })
  await command('Page.enable', {}, sessionId)
  await command('Page.navigate', { url: origin }, sessionId)
  await new Promise(resolve => setTimeout(resolve, 500))
  await command('Runtime.evaluate', { expression: `new Promise(resolve => { let ticks=0; const timer=setInterval(() => { if(document.body?.dataset.result === 'framebuffer-rendered' || ++ticks > 100) { clearInterval(timer); resolve(document.body?.dataset.result || 'timeout') } }, 100) })`, awaitPromise: true, returnByValue: true }, sessionId)
  const screenshot = await command('Page.captureScreenshot', { format: 'png' }, sessionId)
  await Bun.write(join(output, 'desktop-fixture.png'), Buffer.from(screenshot.data, 'base64'))
  const dom = await command('Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true }, sessionId)
  await Bun.write(join(output, 'desktop-fixture.html'), dom.result.value)
  cdp.close()
  await Bun.write(join(output, 'result.json'), JSON.stringify({ rendered, inputMessages, fixtureOnly: true }, null, 2))
  if (!rendered || inputMessages) throw new Error('Actual noVNC fixture did not render safely')
  console.log(`PASS: actual noVNC framebuffer rendered, no input. Artifact: ${join(output, 'desktop-fixture.png')}`)
} finally {
  if (browser && browser.exitCode === null) { browser.kill(); await once(browser, 'exit') }
  gateway?.dispose(); for (const socket of tcpSockets) socket.destroy()
  https.closeAllConnections(); https.close(); tcp.close()
  rmSync(temp, { recursive: true, force: true })
}
