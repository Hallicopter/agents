/** Explicit synthetic QA only: loopback browser, mocked RPC, disposable browser
 * profile. Requires optional Playwright (or PLAYWRIGHT_MODULE) and CHROME_PATH.
 * REGRESSION_BASELINE=<git-sha> reproduces old hooks without editing the worktree.
 */
import { build, preview } from 'vite'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright')
import { mkdir, writeFile } from 'node:fs/promises'
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
if (!process.argv[2]) throw new Error('Usage: bun scripts/qa-mac-regression.mjs <artifact-directory>')
const dir = resolve(process.argv[2])
await mkdir(dir, { recursive: true })
const checks=[]
const check=(name,ok)=>{ if(!ok) throw new Error(name); checks.push(name) }
const configFile=resolve(root, 'apps/electron/vite.config.ts')
const baseline = process.env.REGRESSION_BASELINE
const hooks = ['useLabels.ts', 'useStatuses.ts', 'useViews.ts']
const baselinePlugin = { name: 'baseline-metadata-repro', enforce: 'pre', load(id) {
  if (baseline && hooks.some(h=>id===resolve(root, 'apps/electron/src/renderer/hooks', h))) return execFileSync('git', ['show', `${baseline}:${id.slice(root.length + 1)}`], {cwd:root,encoding:'utf8'})
} }
if (!process.env.SKIP_BUILD) await build({configFile, plugins:[baselinePlugin], build:{outDir:dir+'/fixture-dist',sourcemap:false,rollupOptions:{input:resolve(root,'apps/electron/src/renderer/playground/fixtures/mac-regression.html')}}})
const server = await preview({configFile,build:{outDir:dir+'/fixture-dist'},preview:{host:'127.0.0.1',port:5187,strictPort:true}})
const browser = await chromium.launch({executablePath:process.env.CHROME_PATH || '/usr/bin/google-chrome', headless:true,args:['--no-sandbox']})
try {
 const page = await browser.newPage({viewport:{width:1100,height:1000}})
 const errors=[];page.on('pageerror',e=>errors.push(e.message))
 page.on('console',m=>{if(m.type()==='error')console.error('browser:',m.text())})
 await page.addInitScript(()=>{Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.__copied=text}}})})
 await page.goto('http://127.0.0.1:5187/playground/fixtures/mac-regression.html', {waitUntil:'domcontentloaded',timeout:120000})
 await page.waitForFunction(()=>window.__fixture?.state?.error, undefined, {timeout:120000})
 check('initial failed RPC reproduced',await page.evaluate(()=>window.__fixture.state.labels.length===0))
 await page.evaluate(()=>window.__fixture.connect())
 if (baseline) {
   await page.waitForTimeout(1500)
   const state = await page.evaluate(()=>window.__fixture.state)
   check('old hooks remain empty after transport reconnect', state.labels.length===0 && state.views===0 && state.statuses===0)
   await page.screenshot({path:dir+'/baseline-empty-after-reconnect.png',fullPage:true})
   await writeFile(dir+'/baseline-repro.json',JSON.stringify({baseline,fixture:true,remoteM1:false,state,checks},null,2))
   console.log(JSON.stringify({baseline,checks,state},null,2));
 } else {
 await page.waitForFunction(()=>window.__fixture.state.labels.length===3 && window.__fixture.state.views===1)
 check('labels/status/views recover on connected event',await page.evaluate(()=>window.__fixture.state.statuses===2 && window.__fixture.state.viewMatches===1))
 check('real session assignment chips render hydrated names', await page.getByTestId('assignments').textContent().then(t=>t.includes('Puck Subagent') && t.includes('Puck Automation')))
 const connectedCalls=await page.evaluate(()=>window.__fixture.calls.length)
 await page.evaluate(()=>{ for(let i=0;i<20;i++) window.__fixture.connect() })
 await page.waitForTimeout(100)
 check('duplicate connected snapshots do not trigger RPC storms',await page.evaluate(()=>window.__fixture.calls.length)===connectedCalls)
 check('descendant labels count after hydration',await page.evaluate(()=>window.__fixture.state.count===2))
 await page.evaluate(()=>window.__fixture.filter(true))
 await page.waitForFunction(()=>window.__fixture.state.count===1)
 check('combined view/status/label filter returns correct session',await page.evaluate(()=>window.__fixture.state.ids[0]==='worker'))
 const incoming=page.getByTestId('incoming');const toggle=incoming.locator('button[aria-expanded]')
 check('entire incoming message collapsed',await toggle.getAttribute('aria-expanded')==='false' && !(await incoming.textContent()).includes('RELEASE SUCCEEDED'))
 check('no body/attachments/bubble in collapsed DOM',await incoming.locator('a,[title*="report.txt"],[class*="bg-user-message-bubble"]').count()===0)
 check('actual work-log header class reused',await toggle.getAttribute('class')===await page.getByTestId('work-log').locator('button[aria-expanded]').getAttribute('class'))
 check('ordinary message remains a bubble',await page.getByTestId('ordinary').locator('[class*="bg-user-message-bubble"]').count()===1)
 check('historical SessionViewer path also fully collapsed',await page.getByTestId('historical').locator('button[aria-expanded="false"]').count()===1 && !(await page.getByTestId('historical').textContent()).includes('RELEASE SUCCEEDED'))
 await page.screenshot({path:dir+'/renderer-collapsed-light.png',fullPage:true})
 await toggle.focus();await page.keyboard.press('Enter')
 await incoming.getByText('RELEASE SUCCEEDED',{exact:false}).waitFor()
 check('keyboard Enter expands full raw envelope',await incoming.textContent().then(t=>t.includes('Use send_agent_message') && t.includes('Full raw details')))
 await incoming.getByRole('link',{name:'artifact'}).click()
 check('expanded link callback intact',await page.evaluate(()=>window.__fixture.links[0]==='https://example.com/report'))
 await incoming.getByTitle('Click to open report.txt', {exact:true}).focus(); await page.keyboard.press('Enter')
 check('expanded attachment keyboard callback intact',await page.evaluate(()=>window.__fixture.files[0]==='/fixture/report.txt'))
 await incoming.getByRole('button',{name:'Copy',exact:true}).click()
 check('copy exact raw envelope',await page.evaluate(()=>window.__copied===window.__fixture.raw))
 await page.evaluate(()=>window.__fixture.update(window.__fixture.raw+'\n\nSTREAMED UPDATE'))
 await incoming.getByText('STREAMED UPDATE',{exact:false}).waitFor()
 check('expanded state survives content update',await toggle.getAttribute('aria-expanded')==='true')
 await page.screenshot({path:dir+'/renderer-expanded-light.png',fullPage:true})
 await toggle.focus();await page.keyboard.press('Space')
 await page.waitForTimeout(300)
 check('Space collapses without excerpt',await toggle.getAttribute('aria-expanded')==='false' && !(await incoming.textContent()).includes('STREAMED UPDATE'))
 await page.evaluate(()=>document.documentElement.classList.add('dark'))
 await page.setViewportSize({width:390,height:844})
 await page.screenshot({path:dir+'/renderer-collapsed-dark-narrow.png',fullPage:true})
 check('narrow viewport has no horizontal overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth))
 await toggle.click();await page.waitForTimeout(200)
 await page.screenshot({path:dir+'/renderer-expanded-dark-narrow.png',fullPage:true})
 const before=await page.evaluate(()=>window.__fixture.calls.length)
 await page.evaluate(()=>window.__fixture.labelsChanged('unrelated'))
 await page.waitForTimeout(100)
 check('foreign workspace config event ignored',await page.evaluate(()=>window.__fixture.calls.length)===before)
 await page.evaluate(()=>{window.__fixture.hold('a');window.__fixture.labelsChanged('a');window.__fixture.workspace('b')})
 await page.waitForFunction(()=>window.__fixture.state.labels.join()==='other')
 await page.evaluate(()=>window.__fixture.release())
 await page.waitForTimeout(100)
 check('late prior workspace response ignored',await page.evaluate(()=>window.__fixture.state.labels.join()==='other'))
 await page.evaluate(()=>window.__fixture.disconnect())
 await page.evaluate(()=>window.__fixture.labelsChanged('b'))
 await page.waitForFunction(()=>!!window.__fixture.state.error)
 check('transient failure retains same workspace labels',await page.evaluate(()=>window.__fixture.state.labels.join()==='other'))
 await page.evaluate(()=>window.__fixture.workspace(null))
 await page.waitForFunction(()=>window.__fixture.state.labels.length===0)
 check('clearing workspace removes listeners and metadata',await page.evaluate(()=>window.__fixture.listenerCount()===0))
 await page.evaluate(()=>window.__fixture.workspace('a'))
 await page.evaluate(()=>window.__fixture.connect())
 await page.waitForFunction(()=>window.__fixture.state.labels.length===3)
 await page.evaluate(()=>window.__fixture.unmount())
 check('unmount cleans subscriptions',await page.evaluate(()=>window.__fixture.listenerCount()===0))
 check('no browser runtime exceptions',errors.length===0)
 await writeFile(dir+'/renderer-qa.json',JSON.stringify({fixture:true,remoteM1:false,checks,errors},null,2))
 console.log(JSON.stringify({passed:checks.length,checks,errors},null,2))
 }
} finally {await browser.close();await new Promise(resolve=>server.httpServer.close(resolve))}
