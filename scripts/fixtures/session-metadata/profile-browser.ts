/** Bounded diagnosis on installed Chrome. No installs, remote APIs, or product writes.
 * bun .../profile-browser.ts <artifact-dir> '<query>' <scenario>
 * Scenarios: smoke, profile, focus, equal, list, window-check, bottom-check,
 * threshold-check, threshold-scroll, threshold-scroll-bottom, action-check.
 * See README for synthetic controls, required query options and limitations.
 */
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
const output = resolve(process.argv[2])
await mkdir(output, { recursive: true })
const query = process.argv[3] ?? 'count=1000&history=1000&shell=1'
const scenario = process.argv[4] ?? 'profile'
const chrome = Bun.spawn(['/usr/bin/google-chrome', '--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${output}/chrome-profile`, 'about:blank'], { stdout: 'ignore', stderr: 'pipe' })
const reader = chrome.stderr.getReader(); let logs = ''
const endpoint = await Promise.race([(async () => {
  for (;;) { const { value, done } = await reader.read(); if (done) throw new Error(logs); logs += new TextDecoder().decode(value); const m = logs.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) return m[1] }
})(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Chrome startup timeout')), 15000))])
const ws = new WebSocket(endpoint)
let id = 0; const pending = new Map<number, any>(); const exceptions: any[] = []; const consoleErrors: any[] = []
ws.onmessage = event => {
  const m = JSON.parse(String(event.data))
  if (m.id) { const w = pending.get(m.id); pending.delete(m.id); m.error ? w?.reject(new Error(JSON.stringify(m.error))) : w?.resolve(m.result) }
  else if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails)
  else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push(m.params.args.map((x: any) => x.value ?? x.description).join(' '))
}
await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('CDP failed')) })
async function cdp(method: string, params: any = {}, sessionId?: string): Promise<any> {
  const n = ++id
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(n); reject(new Error(method + ' timeout')) }, 90000)
    pending.set(n, { resolve: (r: any) => { clearTimeout(timer); resolve(r) }, reject: (e: any) => { clearTimeout(timer); reject(e) } })
    ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
}
let sid: string | undefined
const results: any[] = []
try {
  const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' })
  sid = (await cdp('Target.attachToTarget', { targetId, flatten: true })).sessionId
  const page = (method: string, params: any = {}) => cdp(method, params, sid)
  const evaluate = async (expression: string) => {
    const r = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
    return r.result.value
  }
  const settle = (ms = 250) => evaluate(`new Promise(r => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(r)), ${ms}))`)
  const waitFor = (expression: string) => evaluate(`new Promise((resolve,reject) => {
    const check = () => { if (${expression}) { observer.disconnect(); clearTimeout(timer); resolve(true); } };
    const observer = new MutationObserver(check); const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Readiness: ' + document.body.innerText.slice(-1000))); }, 60000);
    observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,characterData:true}); check();
  })`)
  const screenshot = async (name: string) => { const { data } = await page('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await Bun.write(`${output}/${name}.png`, Buffer.from(data, 'base64')) }
  const start = async (label: string) => { await evaluate(`__frontProfile.start(${JSON.stringify(label)})`); await page('Profiler.start') }
  const stop = async (label: string) => {
    await settle(100)
    const r = await evaluate('__frontProfile.stop()'); results.push(r)
    const { profile } = await page('Profiler.stop'); await Bun.write(`${output}/${label}.cpuprofile`, JSON.stringify(profile))
    await Bun.write(`${output}/partial.json`, JSON.stringify({ query, results, exceptions, consoleErrors }, null, 2))
    return r
  }
  async function select(target: string, cold = false, delay = 0) {
    await evaluate(`__frontProfile.select(${JSON.stringify(target)}, ${cold}, ${delay})`)
    await waitFor(`document.querySelector('[data-focus-zone="chat"]')?.textContent.includes(${JSON.stringify(`Synthetic ${target} question`)})`)
    await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
    return evaluate('performance.now() - __frontProfile.switchRequestedAt')
  }
  async function type(count = 12) {
    await evaluate(`document.querySelector('[contenteditable="true"]').focus()`)
    for (let i = 0; i < count; i++) {
      await evaluate('__frontProfile.pendingInput = performance.now()')
      await page('Input.insertText', { text: i % 2 ? 'b' : 'a' })
      await evaluate('new Promise(r=>setTimeout(r,100))')
    }
  }
  await page('Runtime.enable'); await page('Page.enable'); await page('Profiler.enable')
  await page('Profiler.setSamplingInterval', { interval: 1000 })
  await page('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await page('Page.navigate', { url: `http://127.0.0.1:5190/profile.html?${query}` })
  await waitFor(`window.__frontProfile?.ready && document.querySelector('[contenteditable="true"]')`)
  await settle(1000); await screenshot('shell-initial')
  if (scenario.startsWith('threshold-scroll')) {
    await evaluate('__frontProfile.remountList()');await settle(500)
    const cache=await evaluate('__frontProfile.windowCache()')
    const capture=()=>evaluate(`(()=>{const v=document.querySelector('aside [data-radix-scroll-area-viewport]');const y=v.getBoundingClientRect().top;const a=[...v.querySelectorAll('[data-window-row-key]')].find(n=>n.getBoundingClientRect().top>=y+32);return {key:a?.dataset.windowRowKey,relative:a?.getBoundingClientRect().top-y,top:v.scrollTop,max:v.scrollHeight-v.clientHeight};})()`)
    await evaluate(`(()=>{const v=document.querySelector('aside [data-radix-scroll-area-viewport]');v.scrollTop=${scenario.endsWith('bottom')?'v.scrollHeight':'3000'};})()`);await settle(450)
    const before=await capture()
    await evaluate('__frontProfile.addRows(195,196)');await settle(500)
    const after=await evaluate(`(()=>{const v=document.querySelector('aside [data-radix-scroll-area-viewport]');const a=v.querySelector('[data-window-row-key="${before.key}"]');return {relative:a?.getBoundingClientRect().top-v.getBoundingClientRect().top,top:v.scrollTop,max:v.scrollHeight-v.clientHeight};})()`)
    const beforeReverse=await capture()
    await evaluate('__frontProfile.removeRows(195,196)');await settle(500)
    const afterReverse=await evaluate(`(()=>{const v=document.querySelector('aside [data-radix-scroll-area-viewport]');const a=v.querySelector('[data-window-row-key="${beforeReverse.key}"]');return {relative:a?.getBoundingClientRect().top-v.getBoundingClientRect().top,top:v.scrollTop,max:v.scrollHeight-v.clientHeight};})()`)
    const data={cache,before,after,beforeReverse,afterReverse,activationPassed:Math.abs(before.relative-after.relative)<2,deactivationPassed:Math.abs(beforeReverse.relative-afterReverse.relative)<2}
    console.log(JSON.stringify(data));await Bun.write(`${output}/threshold-scroll.json`,JSON.stringify(data,null,2));await screenshot('threshold-scroll-final')
  } else if (scenario === 'threshold-check') {
    const checks: any[]=[]
    const check=(name:string,actual:any,passed:boolean)=>{checks.push({name,actual,passed});console.log(JSON.stringify(checks.at(-1)))}
    const openMenu=async()=>{
      const pos=await evaluate(`(()=>{__frontProfile.menuNode=document.getElementById('item-s-0');const r=__frontProfile.menuNode.getBoundingClientRect();return{x:r.left+100,y:r.top+8}})()`)
      await page('Input.dispatchMouseEvent',{type:'mousePressed',button:'right',x:pos.x,y:pos.y,clickCount:1})
      await page('Input.dispatchMouseEvent',{type:'mouseReleased',button:'right',x:pos.x,y:pos.y,clickCount:1});await settle(200)
    }
    const menuState=()=>evaluate(`({menu:!!document.querySelector('[role="menu"]'),sameNode:document.getElementById('item-s-0')===__frontProfile.menuNode,windowed:!!document.querySelector('[data-windowed-list]'),setsize:document.querySelector('[aria-setsize]')?.getAttribute('aria-setsize')})`)
    await openMenu();await evaluate('__frontProfile.addRows(195,196)');await settle(450)
    let s=await menuState();check('200 -> 201 preserves open menu and exact anchor node',s,s.menu&&s.sameNode&&s.windowed&&s.setsize==='201')
    await evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find(n=>n.textContent.includes('Mark as Unread'))?.click()`);await settle(150)
    let actions=await evaluate('__frontProfile.menuActions')
    check('action after upward crossing targets original session',actions,actions.length===1&&actions[0].id==='s-0')
    await openMenu();await evaluate('__frontProfile.removeRows(195,196)');await settle(450)
    s=await menuState();check('201 -> 200 preserves open menu and exact anchor node',s,s.menu&&s.sameNode&&!s.windowed)
    await evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find(n=>n.textContent.includes('Mark as Unread'))?.click()`);await settle(150)
    actions=await evaluate('__frontProfile.menuActions')
    check('action after downward crossing targets original session',actions,actions.length===2&&actions.every((a:any)=>a.id==='s-0'))
    await Bun.write(`${output}/threshold-checks.json`,JSON.stringify(checks,null,2));await screenshot('threshold-final')
    if(!query.includes('baselineBoundary=1')&&checks.some(c=>!c.passed))throw new Error('Threshold menu checks failed')
  } else if (scenario === 'action-check') {
    const checks: any[] = []
    const check = (name: string, actual: any, passed: boolean) => { checks.push({name,actual,passed});console.log(JSON.stringify(checks.at(-1))) }
    await select('rich');await settle(700)
    const historicalId = await evaluate(`(()=>{__frontProfile.retained=[...__frontProfile.cardActions.values()].find(c=>c.sessionId==='rich');return __frontProfile.retained.messageId;})()`)
    const settings = {name:'Current branch parent',llmConnection:'synthetic-current',model:'current-model',permissionMode:'allow-all',workingDirectory:'/synthetic/current',enabledSourceSlugs:['current-source']}
    await start('fresh-action-stream')
    await evaluate(`__frontProfile.patchSession('rich',${JSON.stringify(settings)})`);await settle(400)
    await evaluate(`__frontProfile.dispatch({type:'text_delta',sessionId:'rich',turnId:'rich',delta:'new answer'})`);await settle(500)
    await evaluate(`__frontProfile.retained.onBranch(${JSON.stringify(historicalId)},{newPanel:false})`);await settle(250)
    const branch = await evaluate('__frontProfile.branches.at(-1)')
    check('historical branch inherits exact current settings after streaming',branch,branch?.workspaceId==='synthetic-performance'&&Object.entries(settings).every(([k,v])=>JSON.stringify(branch.options[k==='name'?'name':k])===JSON.stringify(k==='name'?'Branch of '+v:v))&&branch.options.branchFromMessageId===historicalId&&branch.options.branchFromSessionId==='rich')
    await stop('fresh-action-stream')
    const invokeFollowUp = `__frontProfile.retained.onSaveAndSendFollowUp({messageId:${JSON.stringify(historicalId)},annotationId:'synthetic',note:'test',selectedText:'test'})`
    for(const guards of [{disableSend:true,connectionUnavailable:false},{disableSend:false,connectionUnavailable:true},{disableSend:false,connectionUnavailable:false}]) {
      await evaluate(`__frontProfile.setSendGuards(${JSON.stringify(guards)});__frontProfile.submitEvents=[]`);await settle(250)
      await evaluate(invokeFollowUp);await settle(100)
      const submits=await evaluate('__frontProfile.submitEvents')
      check('retained follow-up respects current guard '+JSON.stringify(guards),submits,submits.length===(guards.disableSend||guards.connectionUnavailable?0:1))
    }
    await evaluate(`__frontProfile.patchSession('rich',{supportsBranching:false})`);await settle(400)
    const countBefore=await evaluate('__frontProfile.branches.length')
    await evaluate(`__frontProfile.retained.onBranch(${JSON.stringify(historicalId)},{newPanel:false})`);await settle(100)
    const removal=await evaluate(`({branches:__frontProfile.branches.length,buttons:[...document.querySelectorAll('[data-focus-zone="chat"] button[aria-label]')].filter(b=>/branch/i.test(b.getAttribute('aria-label'))).length})`)
    check('capability removal hides branch and revokes retained handler',removal,removal.branches===countBefore&&removal.buttons===0)
    await select('plain');await settle(300)
    const switchedBefore=await evaluate('__frontProfile.branches.length')
    await evaluate(`__frontProfile.retained.onBranch(${JSON.stringify(historicalId)},{newPanel:false})`);await settle(100)
    const switchedAfter=await evaluate('__frontProfile.branches.length')
    check('old session handler is inert after card unmount',{switchedBefore,switchedAfter},switchedBefore===switchedAfter)
    await evaluate(`__frontProfile.probeRetained=__frontProfile.cardActions.get('probe:probe-response').onBranch;__frontProfile.probeRetained('probe-response');__frontProfile.prepareUncommitted()`);await settle(300)
    const pending=await evaluate(`({attempts:__frontProfile.probeAttempts,visible:document.querySelector('[data-probe-version]')?.dataset.probeVersion})`)
    await evaluate(`__frontProfile.probeRetained('probe-response')`)
    check('suspended uncommitted candidate does not publish action context',pending,pending.attempts>0&&pending.visible==='1')
    await evaluate(`__frontProfile.commitProbe(3)`);await settle(250);await evaluate(`__frontProfile.probeRetained('probe-response')`)
    await evaluate(`__frontProfile.commitProbe(4)`);await settle(250);await evaluate(`__frontProfile.probeRetained('probe-response')`)
    await evaluate(`__frontProfile.commitProbe(5)`);await settle(250);await evaluate(`__frontProfile.probeRetained('probe-response')`)
    await evaluate(`__frontProfile.unmountProbe()`);await settle(250);await evaluate(`__frontProfile.probeRetained('probe-response')`)
    const calls=await evaluate('__frontProfile.probeCalls')
    check('commits, callback removal, session switch and unmount stay fresh',calls,JSON.stringify(calls)===JSON.stringify([1,1,3,5]))
    await screenshot('action-check-final')
    await Bun.write(`${output}/action-checks.json`,JSON.stringify(checks,null,2))
    if(!query.includes('baselineActions=1')&&checks.some(c=>!c.passed))throw new Error('Action freshness checks failed')
  } else if (scenario === 'bottom-check') {
    await evaluate(`(()=>{const v=document.querySelector('aside [data-radix-scroll-area-viewport]');v.scrollTop=v.scrollHeight})()`);await settle(600)
    await evaluate(`(()=>{const v=document.querySelector('aside [data-radix-scroll-area-viewport]');v.scrollTop=v.scrollHeight})()`);await settle(300)
    const before = await evaluate(`(()=>{const v=document.querySelector('aside [data-radix-scroll-area-viewport]');const top=v.getBoundingClientRect().top;const a=[...v.querySelectorAll('[data-window-row-key]')].find(n=>n.getBoundingClientRect().top>=top+32);return {key:a.dataset.windowRowKey,relative:a.getBoundingClientRect().top-top,top:v.scrollTop,max:v.scrollHeight-v.clientHeight};})()`)
    await evaluate('__frontProfile.removeRows(10,20)');await settle(600)
    const after = await evaluate(`(()=>{const v=document.querySelector('aside [data-radix-scroll-area-viewport]');const a=v.querySelector('[data-window-row-key="${before.key}"]');return {relative:a?.getBoundingClientRect().top-v.getBoundingClientRect().top,top:v.scrollTop,max:v.scrollHeight-v.clientHeight};})()`)
    await Bun.write(`${output}/bottom-check.json`,JSON.stringify({before,after,passed:Math.abs(before.relative-after.relative)<2},null,2))
    await screenshot('bottom-after')
    console.log(JSON.stringify({before,after,passed:Math.abs(before.relative-after.relative)<2}))
  } else if (scenario === 'window-check') {
    const checks: any[] = []
    const check = (name: string, actual: any, passed: boolean) => { checks.push({ name, passed, actual }); console.log(JSON.stringify(checks.at(-1))) }
    const key = async (key: string, code: number, modifiers = 0) => {
      await page('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers })
      await page('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers })
      await settle(350)
    }
    const snapshot = () => evaluate(`(() => { const v=document.querySelector('aside [data-radix-scroll-area-viewport]'); return {rows:v.querySelectorAll('.session-item').length,windowed:!!v.querySelector('[data-windowed-list]'),top:v.scrollTop,height:v.clientHeight,total:v.scrollHeight,active:document.activeElement.id,setsize:document.querySelector('[aria-setsize]')?.getAttribute('aria-setsize')}; })()`)
    let state = await snapshot(); check('initial exceptional family is bounded', state, state.windowed && state.rows < 80 && state.setsize === '1005')
    await evaluate('__frontProfile.focusList()'); await settle(500)
    await key('End', 35)
    state = await snapshot(); check('End mounts and focuses offscreen last row', state, state.active === 'item-s-999' && state.rows < 80 && state.top > 10000)
    await key('Home', 36)
    state = await snapshot(); check('Home returns focus and scroll to first row', state, state.top < 100 && state.active === 'item-idle')
    await key('ArrowDown', 40, 8)
    const selected = await evaluate(`document.querySelectorAll('.session-item .absolute.bg-accent-solid').length`)
    check('Shift+Arrow extends the logical selection', selected, selected >= 2)
    await evaluate(`document.querySelector('aside [data-radix-scroll-area-viewport]').scrollTop=20000`); await settle(500)
    const anchor = await evaluate(`(() => { const v=document.querySelector('aside [data-radix-scroll-area-viewport]'); const top=v.getBoundingClientRect().top; const rows=[...v.querySelectorAll('[data-window-row-key]')]; const a=rows.find(n=>n.getBoundingClientRect().top>=top+32); const above=rows.filter(n=>n.getBoundingClientRect().bottom<top).at(-1); return {key:a.dataset.windowRowKey,top:a.getBoundingClientRect().top-top,above:above.dataset.windowRowKey}; })()`)
    await evaluate(`__frontProfile.patchSession(${JSON.stringify(anchor.above)},{isProcessing:true})`); await settle(600)
    const after = await evaluate(`(() => { const v=document.querySelector('aside [data-radix-scroll-area-viewport]');const a=v.querySelector('[data-window-row-key="${anchor.key}"]');return {top:a.getBoundingClientRect().top-v.getBoundingClientRect().top,rows:v.querySelectorAll('.session-item').length};})()`)
    check('subtitle height above viewport preserves first visible row', { before: anchor, after }, Math.abs(after.top - anchor.top) < 2 && after.rows < 80)
    await evaluate(`document.querySelector('aside').style.width='240px'`); await settle(600)
    state = await snapshot(); check('viewport width changes stay bounded', state, state.windowed && state.rows > 5 && state.rows < 80)
    const position = await evaluate(`(() => {const v=document.querySelector('aside [data-radix-scroll-area-viewport]');const y=v.getBoundingClientRect().top+150;const n=[...v.querySelectorAll('.entity-row-btn')].find(n=>n.getBoundingClientRect().top>=y);const r=n.getBoundingClientRect();return {x:r.left+100,y:r.top+10,id:n.id};})()`)
    await page('Input.dispatchMouseEvent', {type:'mousePressed',button:'right',x:position.x,y:position.y,clickCount:1})
    await page('Input.dispatchMouseEvent', {type:'mouseReleased',button:'right',x:position.x,y:position.y,clickCount:1})
    await settle(250)
    const menu = await evaluate(`!!document.querySelector('[role="menu"]')`)
    await evaluate(`document.querySelector('aside [data-radix-scroll-area-viewport]').scrollTop=1000`); await settle(300)
    const pinned = await evaluate(`!!document.getElementById(${JSON.stringify(position.id)})`)
    check('context menu keeps its offscreen anchor mounted', {menu,pinned,id:position.id},menu&&pinned)
    await key('Escape',27)
    await evaluate(`document.querySelector('aside [data-radix-scroll-area-viewport]').scrollTop=0`); await settle(400)
    await evaluate(`document.querySelector('[data-session-id="s-0"] [data-slot="sub-session-toggle"]').click()`); await settle(450)
    state = await snapshot();check('family collapse keeps full small-list mode',state,!state.windowed&&state.rows<10)
    const collapsedCache=await evaluate('__frontProfile.windowCache()')
    check('removed-row measurement/callback/DOM caches are bounded',collapsedCache,collapsedCache.logical<10&&collapsedCache.sizes<=collapsedCache.logical+collapsedCache.groups&&collapsedCache.callbacks<=collapsedCache.logical+collapsedCache.groups&&collapsedCache.elements<=collapsedCache.logical+collapsedCache.groups)
    await evaluate(`document.querySelector('[data-session-id="s-0"] [data-slot="sub-session-toggle"]').click()`); await settle(450)
    state = await snapshot();check('family re-expansion keeps hierarchy bounded',state,state.windowed&&state.rows<80&&state.setsize==='1005')
    await evaluate(`__frontProfile.patchSession('s-500',{hasUnread:true});__frontProfile.setGrouping('unread')`); await settle(500)
    state = await snapshot()
    const headers = await evaluate(`Array.from(document.querySelectorAll('aside [data-slot="list-group-header"]')).map(n=>({label:n.textContent,expanded:n.getAttribute('aria-expanded')}))`)
    check('unread regrouping keeps two headers and complete logical family', {state,headers}, state.windowed&&state.setsize==='1005'&&headers.length===2&&headers[0].label.includes('1'))
    await evaluate(`document.querySelector('aside [data-slot="list-group-header"]').click()`); await settle(400)
    state = await snapshot(); check('group collapse retains counted placeholder and other rows',state,!state.windowed&&state.rows===5)
    await evaluate(`document.querySelector('aside [data-slot="list-group-header"]').click()`); await settle(400)
    state = await snapshot(); check('group re-expansion restores bounded full family',state,state.windowed&&state.rows<80&&state.setsize==='1005')
    await evaluate(`__frontProfile.setSearch('Synthetic')`); await settle(600)
    state = await snapshot()
    const searchFocus = await evaluate(`document.activeElement.tagName`)
    check('capped flat search keeps100 full rows and input focus',{state,searchFocus},!state.windowed&&state.rows===100&&searchFocus==='INPUT')
    await screenshot('window-check-final')
    await Bun.write(`${output}/checks.json`,JSON.stringify(checks,null,2))
    if(checks.some(c=>!c.passed)) throw new Error('Window interaction checks failed; see checks.json')
  } else if (scenario === 'equal') {
    await select('rich'); await settle(700)
    await start('equal-count-stream')
    await evaluate('(() => { __frontProfile.pacing = __frontProfile.fixedPace(40); return true; })()')
    await type(12)
    const pacing = await evaluate('__frontProfile.pacing')
    const r = await stop('equal-count-stream'); r.pace = pacing
    const normalized = await evaluate('JSON.stringify(__frontProfile.normalizedOutput())')
    await Bun.write(`${output}/normalized-output.json`, normalized)
    await screenshot('equal-count-complete')
  } else if (scenario === 'list') {
    for (const target of ['plain', 'rich']) {
      await start('list-switch-' + target)
      const ms = await select(target)
      const r = await stop('list-switch-' + target); r.switchToTwoFramesMs = ms
      await select('idle'); await settle(500)
    }
    await start('five-status-changes')
    for (let i = 0; i < 5; i++) {
      await evaluate(`__frontProfile.dispatch({type:'session_status_changed',sessionId:'s-${i}',sessionStatus:'in-progress'})`)
      await evaluate('new Promise(r=>setTimeout(r,200))')
    }
    await type(6)
    await stop('five-status-changes')
    const geometry = await evaluate(`Array.from(document.querySelectorAll('[data-radix-scroll-area-viewport]')).map(e=>({height:e.clientHeight,scrollHeight:e.scrollHeight,rows:e.querySelectorAll('.session-item').length}))`)
    await Bun.write(`${output}/geometry.json`, JSON.stringify(geometry, null, 2))
    await screenshot('list-final')
  } else if (scenario !== 'smoke') {
    await start('idle-typing'); await type(); await stop('idle-typing')
    for (const metadataEvery of [0, 200]) {
      const label = metadataEvery ? 'paced-with-metadata' : 'paced-background'
      await start(label)
      await evaluate(`(() => { __frontProfile.pacing = __frontProfile.pace(4000, ${metadataEvery}, false); return true; })()`)
      await type(20)
      const pace = await evaluate('__frontProfile.pacing'); const r = await stop(label); r.pace = pace
    }
    for (const target of (scenario === 'focus' ? ['plain', 'rich'] : ['plain', 'rich', 'large'])) {
      const label = 'switch-' + target
      await start(label)
      const switchMs = await select(target)
      const r = await stop(label); r.switchToTwoFramesMs = switchMs
      await screenshot(label)
      await start(target + '-typing'); await type(); await stop(target + '-typing')
      await select('idle'); await settle()
    }
    const switchMs = await select(scenario === 'focus' ? 'rich' : 's-0')
    await settle(500)
    await start('visible-stream')
    await evaluate('(() => { __frontProfile.pacing = __frontProfile.pace(4000, 0, true); return true; })()')
    await type(20)
    const pace = await evaluate('__frontProfile.pacing'); const visible = await stop('visible-stream'); visible.pace = pace; visible.switchToTwoFramesMs = switchMs
    await select('idle'); await settle()
    if (!query.includes('shell=0')) {
      await start('cold-switch-zero-delay')
      const coldSwitchMs = await select('cold', true, 0)
      const cold = await stop('cold-switch-zero-delay'); cold.switchToTwoFramesMs = coldSwitchMs
    }
    // Wheel on the actual transcript scroll area; frame/longtask metrics are proxies, not display capture.
    await start('transcript-scroll')
    const point = await evaluate(`(() => {const e=document.querySelector('[data-focus-zone="chat"] [data-radix-scroll-area-viewport]'); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()`)
    for (let i = 0; i < 10; i++) { await page('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaY: -450, deltaX: 0 }); await evaluate('new Promise(r=>setTimeout(r,100))') }
    await stop('transcript-scroll'); await screenshot('after-scroll')
  }
  const summary = { query, scope: 'actual AppShell/ChatPage if shell=1, not MainApp/transport/backend/native', results, exceptions, consoleErrors }
  await Bun.write(`${output}/results.json`, JSON.stringify(summary, null, 2))
  console.log(JSON.stringify({ query, completed: results.map(r => r.label), exceptions: exceptions.length, consoleErrors: consoleErrors.length }))
} catch (error) {
  if (sid) {
    const r = await cdp('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true }, sid)
    await Bun.write(`${output}/failure-dom.txt`, r.result.value ?? '')
    const { data } = await cdp('Page.captureScreenshot', { format: 'png' }, sid)
    await Bun.write(`${output}/failure.png`, Buffer.from(data, 'base64'))
  }
  await Bun.write(`${output}/errors.json`, JSON.stringify({ exceptions, consoleErrors, results }, null, 2))
  throw error
} finally { await cdp('Browser.close').catch(() => {}); ws.close() }
