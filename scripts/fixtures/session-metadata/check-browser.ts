/** Bounded actual-UI check with installed Chrome; no browser/tool install or live server.
 * Start fixture Vite, then: bun scripts/fixtures/session-metadata/check-browser.ts /absolute/artifacts/dir
 * Optional CHROME_PATH selects an already-installed Chrome binary.
 */
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const output = resolve(process.argv[2] ?? '.perf-preview/session-metadata-check')
await mkdir(output, { recursive: true })
const chrome = Bun.spawn([process.env.CHROME_PATH ?? '/usr/bin/google-chrome',
  '--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking',
  '--disable-component-update', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
  `--user-data-dir=${output}/chrome-profile`, 'about:blank'], { stdout: 'ignore', stderr: 'pipe' })
const stderrReader = chrome.stderr.getReader()
let stderr = ''
const endpoint = await Promise.race([
  (async () => {
    while (true) {
      const { value, done } = await stderrReader.read()
      if (done) throw new Error(`Chrome exited before DevTools: ${stderr}`)
      stderr += new TextDecoder().decode(value)
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)
      if (match) return match[1]
    }
  })(),
  new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Chrome startup exceeded 15s')), 15000)),
])
const ws = new WebSocket(endpoint)
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
const errors: unknown[] = []
let nextId = 0
ws.onmessage = event => {
  const message = JSON.parse(String(event.data))
  if (message.id) {
    const waiter = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) waiter?.reject(new Error(JSON.stringify(message.error)))
    else waiter?.resolve(message.result)
  } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
  else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push(message.params.args)
}
await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('DevTools websocket failed')) })
async function cdp(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
  const id = ++nextId
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`${method} exceeded 60s`)) }, 60000)
    pending.set(id, { resolve: result => { clearTimeout(timeout); resolve(result) }, reject: error => { clearTimeout(timeout); reject(error) } })
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
}
let sessionId: string | undefined
try {
  const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' })
  ;({ sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true }))
  const page = (method: string, params: Record<string, unknown> = {}) => cdp(method, params, sessionId)
  async function evaluate(expression: string) {
    const result = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  async function screenshot(name: string) {
    const { data } = await page('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    await Bun.write(`${output}/${name}.png`, Buffer.from(data, 'base64'))
  }
  async function waitFor(expression: string) {
    return evaluate(`new Promise((resolve, reject) => {
      const check = () => { if (${expression}) { observer.disconnect(); clearTimeout(timer); resolve(true); } };
      const observer = new MutationObserver(check);
      const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Fixture condition timed out: ' + document.body.innerText.slice(0, 1000))); }, 45000);
      observer.observe(document.documentElement, {childList:true, subtree:true, characterData:true, attributes:true}); check();
    })`)
  }
  const click = (text: string) => evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes(${JSON.stringify(text)}));
    if (!button) throw new Error('Button not found'); button.click();
  })()`)
  await page('Runtime.enable')
  await page('Page.enable')
  await page('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await page('Page.navigate', { url: 'http://127.0.0.1:5187/' })
  await waitFor(`document.body.innerText.includes('Run 2,000 background deltas') && document.querySelector('[contenteditable="true"]')`)
  await screenshot('initial')
  await evaluate(`(() => { const input = document.querySelector('[contenteditable="true"]'); input.focus(); })()`)
  await page('Input.insertText', { text: ' Typed through Chrome input.' })
  const draftBefore = await evaluate(`document.querySelector('[contenteditable="true"]').textContent`)
  const runs = []
  for (const baseline of [true, false]) {
    await evaluate(`(() => { const checkbox = document.querySelector('input[type="checkbox"]'); if (checkbox.checked !== ${baseline}) checkbox.click(); window.__metadataFixtureResult = null; })()`)
    await click('Run 2,000 background deltas')
    await waitFor(`window.__metadataFixtureResult !== null`)
    const metrics = await evaluate('window.__metadataFixtureResult')
    const draftAfter = await evaluate(`document.querySelector('[contenteditable="true"]').textContent`)
    if (draftAfter !== draftBefore) throw new Error('Draft changed during background traffic')
    if (metrics.transcript !== 2000 || metrics.metadata !== (baseline ? 2000 : 0)) throw new Error('Unexpected notification count')
    runs.push({ ...metrics, draftPreserved: true })
    await screenshot(baseline ? 'base-after-burst' : 'fixed-after-burst')
  }
  await click('Complete background turns')
  await waitFor(`document.querySelector('output').textContent.includes('Complete:')`)
  // Select a real SessionList row via its text, then check authoritative final transcript.
  const rowPoint = await evaluate(`(() => {
    const row = Array.from(document.querySelectorAll('*')).find(e => e.textContent === 'Synthetic session 0' && e.children.length === 0);
    if (!row) throw new Error('Session row missing'); row.scrollIntoView({block:'center'});
    const rect = row.getBoundingClientRect(); return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2};
  })()`)
  // Session rows activate on mousedown, not programmatic .click().
  await page('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...rowPoint })
  await page('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...rowPoint })
  await waitFor(`document.body.innerText.includes('Background 0 finished — final text preserved.')`)
  await screenshot('completed-background-selected')
  await click('Open draft chat')
  await waitFor(`document.body.innerText.includes('Can I keep this draft')`)
  const draftAfterSwitch = await evaluate(`document.querySelector('[contenteditable="true"]').textContent`)
  if (draftAfterSwitch !== draftBefore) throw new Error('Draft changed after session switch')
  await screenshot('draft-after-switch')
  const result = { url: 'http://127.0.0.1:5187/', viewport: { width: 1440, height: 900 },
    fixture: 'Production SessionList + ChatDisplay; synthetic in-memory adapter; NOT full AppShell, backend ACK, or live workload',
    runs, draftSurvivedSessionSwitch: true, errors }
  await Bun.write(`${output}/browser-results.json`, JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  if (sessionId) {
    const result = await cdp('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true }, sessionId)
    await Bun.write(`${output}/failure-dom.txt`, result.result.value ?? '')
    const shot = await cdp('Page.captureScreenshot', { format: 'png' }, sessionId)
    await Bun.write(`${output}/failure.png`, Buffer.from(shot.data, 'base64'))
  }
  await Bun.write(`${output}/browser-errors.json`, JSON.stringify(errors, null, 2))
  throw error
} finally {
  await cdp('Browser.close').catch(() => {})
  ws.close()
}
