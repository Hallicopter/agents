/** Offline real-composer interaction tests for BOTH renderer build configurations.
 * Usage: PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs bun apps/webui/tests/openai-speed.browser.mjs /absolute/artifact-dir
 * Only an owned loopback preview server is started; no Craft service, provider or credentials.
 */
import { build, preview } from 'vite'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright')
const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
if (!process.argv[2]) throw new Error('Provide an artifact directory outside production build outputs')
const artifacts = resolve(process.argv[2])
await mkdir(artifacts, { recursive: true })
const checks = []
const check = (name, ok) => { if (!ok) throw new Error(name); checks.push(name) }
async function findHtml(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (item.isDirectory()) { const found = await findHtml(resolve(dir, item.name)); if (found) return found }
    else if (item.name.endsWith('.html')) return resolve(dir, item.name)
  }
}
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] })
try {
  for (const [surface, config, port] of [['electron', 'apps/electron/vite.config.ts', 5198], ['web', 'apps/webui/vite.config.ts', 5199]]) {
    const dir = resolve(artifacts, surface)
    await mkdir(dir, { recursive: true })
    const configFile = resolve(root, config)
    await build({ configFile, logLevel: 'warn', build: { outDir: resolve(dir, 'dist'), sourcemap: false, rollupOptions: { input: resolve(root, surface === 'web' ? 'apps/webui/src/__fixtures__/openai-speed.html' : 'apps/electron/src/renderer/playground/fixtures/openai-speed.html') } } })
    const server = await preview({ configFile, logLevel: 'warn', build: { outDir: resolve(dir, 'dist') }, preview: { host: '127.0.0.1', port, strictPort: true } })
    const errors = []
    const blocked = []
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') console.error(surface, message.text()) })
    await page.route('**/*', route => {
      const url = new URL(route.request().url())
      if (url.origin === `http://127.0.0.1:${port}`) return route.continue()
      blocked.push(url.origin)
      return route.abort()
    })
    try {
      const html = await findHtml(resolve(dir, 'dist'))
      await page.goto(`http://127.0.0.1:${port}/${html.slice(resolve(dir, 'dist').length + 1)}`, { waitUntil: 'networkidle', timeout: 120000 })
      await page.waitForFunction(() => window.__speedFixture?.configure)
      const set = options => page.evaluate(async options => {
        window.__speedFixture.configure(options)
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      }, options)
      const callCount = () => page.evaluate(() => window.__speedFixture.calls.length)
      const chip = () => page.getByRole('button', { name: /OpenAI speed — Requested:/, includeHidden: true })
      const dialog = () => page.getByRole('dialog', { name: 'OpenAI speed request' })
      const radio = name => page.getByRole('radio', { name, exact: true })
      const cancel = () => page.getByRole('button', { name: 'Cancel', exact: true })
      const expectChip = async speed => { await page.getByRole('button', { name: `OpenAI speed — Requested: ${speed}`, exact: true }).waitFor() }
      for (const compact of [false, true]) {
        const mode = `${surface}/${compact ? 'compact' : 'full'}`
        await page.setViewportSize({ width: compact ? 390 : 1100, height: compact ? 844 : 900 })
        await set({ compact, provider: 'openai-codex', providerType: 'pi', session: { openAISpeed: undefined, model: 'pi/gpt-6.2-sol', isProcessing: false } })
        await expectChip('Standard')
        check(`${mode}: default Standard is visible`, await chip().isVisible())
        await chip().focus(); await page.keyboard.press('Enter')
        await dialog().waitFor()
        check(`${mode}: labelled modal and conservative focus`, await cancel().evaluate(el => document.activeElement === el) && await dialog().getAttribute('aria-describedby') !== null)
        await page.keyboard.press('Tab'); await page.keyboard.press('Tab')
        check(`${mode}: forward Tab remains inside the modal`, await dialog().evaluate(el => el.contains(document.activeElement)))
        await cancel().focus(); await page.keyboard.press('Shift+Tab')
        check(`${mode}: backward Tab remains inside the modal`, await dialog().evaluate(el => el.contains(document.activeElement)))
        check(`${mode}: Standard checked and explicit recovery available`, await radio('Standard').isChecked() && await page.getByRole('button', { name: 'Request Standard', exact: true }).isEnabled())
        await radio('Standard').focus(); await page.keyboard.press('ArrowDown')
        check(`${mode}: native arrow-key selection works`, await radio('Fast').isChecked())
        await page.keyboard.press('ArrowDown')
        check(`${mode}: keyboard can select Ultrafast`, await radio('Ultrafast').isChecked())
        const expected = await page.evaluate(() => window.__speedFixture.warning('ultrafast'))
        check(`${mode}: exact policy caveats shown`, await page.getByRole('note').textContent() === expected && expected.includes('6×') && /US.*only/.test(expected))
        const countBeforeCancel = await callCount()
        await page.keyboard.press('Escape')
        await dialog().waitFor({ state: 'hidden' })
        check(`${mode}: Escape cancels without command or tier change`, await callCount() === countBeforeCancel && await chip().textContent().then(text => text.includes('Standard')))
        check(`${mode}: focus restored to trigger`, await chip().evaluate(el => document.activeElement === el))

        await chip().click(); await radio('Fast').check(); await cancel().click()
        check(`${mode}: Cancel leaves request unchanged`, await callCount() === countBeforeCancel)
        await chip().click(); await radio('Ultrafast').check()
        await page.evaluate(() => { window.__speedFixture.mode = 'hold' })
        await page.getByRole('button', { name: 'Confirm Ultrafast request', exact: true }).click()
        await page.getByRole('button', { name: 'Requesting…', exact: true }).waitFor()
        check(`${mode}: pending does not optimistically change chip`, await chip().textContent().then(text => text.includes('Standard')))
        check(`${mode}: pending blocks duplicate confirmation and dismissal`, await cancel().isDisabled() && await radio('Standard').isDisabled())
        await page.keyboard.press('Escape')
        check(`${mode}: pending keeps outcome visible`, await dialog().isVisible())
        const call = await page.evaluate(() => window.__speedFixture.calls.at(-1))
        check(`${mode}: premium command explicitly acknowledged`, call[1].type === 'setOpenAISpeed' && call[1].speed === 'ultrafast' && call[1].acknowledged === true)
        await page.evaluate(() => { window.__speedFixture.mode = 'success'; window.__speedFixture.release() })
        await dialog().waitFor({ state: 'hidden' }); await expectChip('Ultrafast')
        await page.screenshot({ path: resolve(dir, `${compact ? 'compact' : 'full'}-requested.png`), fullPage: true })
        check(`${mode}: no page overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
        check(`${mode}: model, provider and message unchanged`, await page.evaluate(() => !window.__speedFixture.modelChanges.length && !window.__speedFixture.providerChanges.length && !window.__speedFixture.submissions.length))

        await chip().click(); await radio('Standard').check()
        await page.getByRole('button', { name: 'Request Standard', exact: true }).click()
        await dialog().waitFor({ state: 'hidden' }); await expectChip('Standard')
        const reset = await page.evaluate(() => window.__speedFixture.calls.at(-1)[1])
        check(`${mode}: explicit Standard reset needs no paid acknowledgment`, reset.speed === 'standard' && !('acknowledged' in reset))

        for (const [failure, message] of [['error', 'Synthetic account eligibility failure'], ['reject', 'Synthetic disconnected transport']]) {
          await page.evaluate(mode => { window.__speedFixture.mode = mode }, failure)
          await chip().click(); await radio('Fast').check()
          await page.getByRole('button', { name: 'Confirm Fast request', exact: true }).click()
          await page.getByRole('alert').waitFor()
          check(`${mode}: ${failure} visible and authoritative tier unchanged`, await page.getByRole('alert').textContent().then(text => text.includes(message)) && await chip().textContent().then(text => text.includes('Standard')))
          await page.screenshot({ path: resolve(dir, `${compact ? 'compact' : 'full'}-${failure}.png`), fullPage: true })
          await page.evaluate(() => { window.__speedFixture.mode = 'success' })
          await radio('Standard').check()
          await page.getByRole('button', { name: 'Request Standard', exact: true }).click()
          await dialog().waitFor({ state: 'hidden' }); await expectChip('Standard')
          const recovery = await page.evaluate(() => window.__speedFixture.calls.at(-1)[1])
          check(`${mode}: ${failure} permits same-Standard recovery request`, recovery.type === 'setOpenAISpeed' && recovery.speed === 'standard' && !('acknowledged' in recovery))
        }
        await page.evaluate(() => { window.__speedFixture.mode = 'success' })
        await set({ session: { isProcessing: true } })
        check(`${mode}: processing disables tier changes`, await chip().isDisabled())
        await set({ session: { isProcessing: false } })
        await set({ provider: undefined })
        await chip().waitFor({ state: 'hidden' })
        check(`${mode}: undefined provider hides paid selector`, await chip().count() === 0)
        await set({ provider: 'openai-codex', providerType: 'pi_compat' })
        await chip().waitFor({ state: 'hidden' })
        check(`${mode}: compatible-provider names cannot imply eligibility`, await chip().count() === 0)
        await set({ provider: 'openai-codex', providerType: 'pi', session: { model: 'pi/gpt-6.1-sol' } })
        await chip().click()
        check(`${mode}: OAuth Ultrafast model restriction respected`, await page.getByRole('radio', { name: /Ultrafast — unavailable/ }).isDisabled())
        await cancel().click()
        await set({ provider: 'openai', session: { model: 'pi/gpt-6.2-sol' } })
        await chip().click(); await radio('Ultrafast').check()
        check(`${mode}: API caveat uses exact separate-billing warning`, await page.getByRole('note').textContent() === await page.evaluate(() => window.__speedFixture.warning('ultrafast')) && await page.getByRole('note').textContent().then(text => text.includes('separate API billing')))
        await page.screenshot({ path: resolve(dir, `${compact ? 'compact' : 'full'}-warning.png`), fullPage: true })
        await cancel().click()
        await set({ provider: 'unrelated', session: { openAISpeed: 'ultrafast' } })
        await expectChip('Ultrafast'); await chip().click()
        check(`${mode}: incompatible saved request is not silently downgraded`, await page.getByRole('radio', { name: /Ultrafast — unavailable/ }).isChecked())
        await radio('Standard').check(); await page.getByRole('button', { name: 'Request Standard', exact: true }).click()
        await dialog().waitFor({ state: 'hidden' })
        await chip().waitFor({ state: 'hidden' })
        await set({ provider: 'openai-codex', session: { openAISpeed: 'ultrafast', model: 'pi/gpt-6.2-sol' } })
        await expectChip('Ultrafast')
        await page.evaluate(() => window.__speedFixture.newConversation())
        await expectChip('Standard')
        check(`${mode}: new conversation does not inherit paid speed`, await page.evaluate(() => window.__speedFixture.session.openAISpeed === undefined))

        // Canonical renderer replay only: NOT a live provider response or successful Ultrafast.
        // The separately owned adapter fix supplies this golden error+complete payload.
        await set({ provider: 'openai', session: {
          openAISpeed: 'ultrafast', isProcessing: true, messages: [],
          tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
        } })
        const beforeReplay = await callCount()
        await page.evaluate(() => window.__speedFixture.applyEvents(window.__speedFixture.speedMismatchEvents()))
        const assertAccounting = async phase => {
          await page.waitForFunction(() => window.__speedFixture.session.tokenUsage?.costUsd === 0.013568)
          const snapshot = await page.evaluate(() => ({
            usage: window.__speedFixture.session.tokenUsage,
            requested: window.__speedFixture.session.openAISpeed,
            processing: window.__speedFixture.session.isProcessing,
            roles: window.__speedFixture.session.messages.map(message => message.role),
            turnTypes: window.__speedFixture.turnTypes,
          }))
          check(`${mode}/${phase}: actual consumed 6714 input and 14 output retained`, snapshot.usage.inputTokens === 6714 && snapshot.usage.outputTokens === 14 && snapshot.usage.totalTokens === 6728)
          check(`${mode}/${phase}: native context occupancy 11000 coexists with consumed input 6714`, snapshot.usage.contextUsage?.usedTokens === 11000 && snapshot.usage.inputTokens === 6714 && await page.getByTestId('native-context-occupancy').textContent() === '11000')
          check(`${mode}/${phase}: Standard cost estimate is not premium-multiplied`, snapshot.usage.costUsd === 0.013568 && snapshot.usage.costUsd !== 0.013568 * 3 && snapshot.usage.costUsd !== 0.013568 * 6)
          check(`${mode}/${phase}: saved Requested Ultrafast remains unchanged and idle`, snapshot.requested === 'ultrafast' && snapshot.processing === false)
          await expectChip('Ultrafast')
          check(`${mode}/${phase}: consumed usage and estimate visible in labelled fixture diagnostics`,
            await page.getByTestId('consumed-input').textContent() === '6714'
            && await page.getByTestId('consumed-output').textContent() === '14'
            && await page.getByTestId('consumed-total').textContent() === '6728'
            && await page.getByTestId('standard-estimate').textContent() === '0.013568')
          const transcript = page.getByTestId('accounting-transcript')
          check(`${mode}/${phase}: mismatch is an actual error marker, never an assistant answer`,
            JSON.stringify(snapshot.roles) === '["error"]' && JSON.stringify(snapshot.turnTypes) === '["system"]'
            && await transcript.locator('[data-message-role="error"] .bg-destructive-tint').count() === 1
            && await transcript.locator('[data-message-role="assistant"]').count() === 0
            && await transcript.textContent().then(text => text.includes('provider returned default')))
          check(`${mode}/${phase}: offline mismatch is explicitly not Ultrafast success`, await page.getByTestId('mismatch-accounting').textContent().then(text => text.includes('NOT a successful Ultrafast response or actual billing proof')))
          await page.screenshot({ path: resolve(dir, `${compact ? 'compact' : 'full'}-mismatch-${phase}.png`), fullPage: true, animations: 'disabled' })
          const modelButton = compact
            ? page.getByRole('button', { name: 'Model: gpt-6.2-sol', exact: true })
            : page.getByRole('button', { name: 'gpt-6.2-sol', exact: true })
          await modelButton.click()
          const contextUsage = page.getByText(/11k/)
          await contextUsage.waitFor()
          await contextUsage.scrollIntoViewIfNeeded()
          await page.screenshot({ path: resolve(dir, `${compact ? 'compact' : 'full'}-mismatch-${phase}-context.png`), fullPage: true, animations: 'disabled' })
          check(`${mode}/${phase}: actual composer footer shows native 11k occupancy, not consumed 6.7k`, await contextUsage.evaluate(el => {
            const r = el.getBoundingClientRect()
            return el.textContent.includes('11k') && !el.textContent.includes('6.7k') && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth
          }))
          await page.keyboard.press('Escape')
        }
        await assertAccounting('live')
        check(`${mode}: replay does not issue a session or provider request`, await callCount() === beforeReplay)
        const savedSnapshot = await page.evaluate(() => window.__speedFixture.saveSnapshot())
        await writeFile(resolve(dir, `${compact ? 'compact' : 'full'}-mismatch-saved-session.json`), savedSnapshot)
        // Cross a real browser reload, then rebuild saved state via initializeSessionsAtom.
        await page.reload({ waitUntil: 'networkidle' })
        await page.waitForFunction(() => window.__speedFixture?.reloadSnapshot)
        await set({ compact, provider: 'openai', providerType: 'pi' })
        await page.evaluate(snapshot => window.__speedFixture.reloadSnapshot(snapshot), savedSnapshot)
        await assertAccounting('reloaded')
        check(`${mode}: initializer rebuilt saved nonzero usage and requested-tier metadata`, await page.evaluate(() => {
          const meta = window.__speedFixture.reloadedMetadata
          return meta?.tokenUsage?.inputTokens === 6714 && meta.tokenUsage.outputTokens === 14
            && meta.tokenUsage.totalTokens === 6728 && meta.tokenUsage.costUsd === 0.013568
            && meta.tokenUsage.contextUsage?.usedTokens === 11000
            && meta.openAISpeed === 'ultrafast' && meta.messageCount === 1
        }))
        check(`${mode}: reload restoration issues no session or provider request`, await callCount() === 0)
        await page.evaluate(() => window.__speedFixture.newConversation())
        await expectChip('Standard')
      }
      await page.setViewportSize({ width: 320, height: 568 })
      await set({ compact: true, provider: 'openai-codex', providerType: 'pi', session: { openAISpeed: 'standard', model: 'pi/gpt-6.2-sol', isProcessing: false } })
      await expectChip('Standard')
      check(`${surface}/minimum-width: model, speed and send do not overlap`, await page.evaluate(() => {
        const speed = document.querySelector('button[aria-label^="OpenAI speed"]')?.getBoundingClientRect()
        const model = document.querySelector('button[aria-label^="Model:"]')?.getBoundingClientRect()
        const send = document.querySelector('button[data-tutorial="send-button"]')?.getBoundingClientRect()
        return speed && model && send && model.width >= 28 && speed.height >= 44
          && model.right <= speed.left && speed.right <= send.left && send.right <= innerWidth
      }))
      await page.screenshot({ path: resolve(dir, '320-requested.png'), fullPage: true })
      await page.evaluate(() => window.__speedFixture.theme('dark'))
      await page.waitForFunction(() => document.documentElement.classList.contains('dark'))
      await chip().click(); await radio('Ultrafast').check()
      await page.screenshot({ path: resolve(dir, '320-dark-warning.png'), fullPage: true })
      check(`${surface}/minimum-width: warning dialog fits and scrolls without page overflow`, await dialog().evaluate(el => {
        const r = el.getBoundingClientRect()
        return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight + 1
          && document.documentElement.scrollWidth <= innerWidth
      }))
      await cancel().click()
      check(`${surface}: no browser runtime errors`, errors.length === 0)
      check(`${surface}: no nonlocal network attempted`, blocked.length === 0)
      await writeFile(resolve(dir, 'results.json'), JSON.stringify({ checks: checks.filter(name => name.startsWith(surface + '/')), errors, blocked }, null, 2))
    } finally {
      await page.close()
      await new Promise(resolve => server.httpServer.close(resolve))
    }
  }
} finally { await browser.close() }
await writeFile(resolve(artifacts, 'results.json'), JSON.stringify({ offline: true, providerCalls: 0, accounting: 'Canonical synthetic error+complete replay, not actual provider billing or Ultrafast success', checks }, null, 2))
console.log(JSON.stringify({ passed: checks.length, artifacts }, null, 2))
