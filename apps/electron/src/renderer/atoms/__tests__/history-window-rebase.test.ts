import {expect,it,afterEach} from 'bun:test'
import {createStore} from 'jotai'
import {observeHistory,forgetHistory} from '../history-replay'
import {readWindow} from '../history-transfer'
import {sessionAtomFamily,windowWorkspaceIdAtom,ensureSessionMessagesLoadedAtom,forceSessionMessagesReloadAtom,pendingPermissionsAtom} from '../sessions'
import {registerHistoryWindow} from '../../../../../../packages/server-core/src/handlers/rpc/history-window'
import {serializeEnvelope} from '../../../../../../packages/server-core/src/transport/codec'
const original=globalThis.window
const user=(id:string,pending=false)=>({id,content:'identical',role:'user',timestamp:1,isQueued:true,isPending:pending})
const metadata={id:'s',workspaceId:'w',workspaceName:'W',isProcessing:true,hasUnread:true}
const event=(type:string,seq:number,rest:any)=>({type,sessionId:'s',historyEpoch:'epoch',historySeq:seq,...rest} as any)
afterEach(()=>{forgetHistory();globalThis.window=original})
it('open streaming, two equal submissions, late acknowledgement, cancel, and authoritative stale reconnect',async()=>{
 const store=createStore();store.set(windowWorkspaceIdAtom,'w');store.set(sessionAtomFamily('s'),{...metadata,hasUnread:false,messages:[user('a',true),user('b',true)]} as any)
 const approval={requestId:'request',sessionId:'s',toolName:'Synthetic tool',description:'Synthetic approval'};let resolve!:(p:any)=>void,reads=0
 globalThis.window={electronAPI:{isChannelAvailable:()=>true,getSessionHistoryWindow:()=>{reads++;return new Promise(r=>resolve=r)}}} as any
 const open=store.set(ensureSessionMessagesLoadedAtom,'s');const text=(i:number,delta:string)=>event('text_delta',i,{delta,turnId:'turn'})
 observeHistory('s',text(10,'A'));observeHistory('s',text(11,'B'));observeHistory('s',event('user_message',12,{message:user('b'),status:'queued',optimisticMessageId:'b'}))
 resolve({epoch:'epoch',watermark:10,metadata,messages:[user('a'),{id:'stream',role:'assistant',content:'A',turnId:'turn',isStreaming:true,isPending:true}],older:null,pendingPermissions:[approval]});const merged=await open
 expect(merged?.messages.map(m=>m.id)).toEqual(['a','stream','b']);expect(merged?.messages[1].content).toBe('AB');expect(merged?.hasUnread).toBe(false);expect(store.get(pendingPermissionsAtom).get('s')).toEqual([approval]);expect(observeHistory('s',text(11,'B'))).toBe(false)
 const reconnect=store.set(forceSessionMessagesReloadAtom,'s');observeHistory('s',event('interrupted',14,{cancelledIds:['a'],message:{id:'stop',role:'info',content:'stop',timestamp:4}}));resolve({epoch:'epoch',watermark:13,metadata,messages:[user('a'),user('b')],older:null,pendingPermissions:[]});expect((await reconnect)?.messages.map(m=>m.id)).toEqual(['b','stop']);expect(store.get(pendingPermissionsAtom).get('s')).toEqual([]);expect(reads).toBe(2)
})
it('workspace switch discards an old response without installing its stamp',async()=>{const store=createStore();store.set(windowWorkspaceIdAtom,'w');let resolve!:(p:any)=>void;globalThis.window={electronAPI:{isChannelAvailable:()=>true,getSessionHistoryWindow:()=>new Promise(r=>resolve=r)}} as any;const open=store.set(forceSessionMessagesReloadAtom,'s');store.set(windowWorkspaceIdAtom,'other');resolve({epoch:'epoch',watermark:100,metadata,messages:[],older:null});expect(await open).toBeNull();expect(observeHistory('s',event('complete',1,{}))).toBe(true)})
it('bounded chunks reconstruct oversized metadata and records, cursor survives append but not replacement',async()=>{
 const big='\u0001🌶️"'.repeat(65000), messages=Array.from({length:140},(_,i)=>user('m'+i));messages[139].content=big;const session={...metadata,preview:big,messages};let handle:any
 registerHistoryWindow({handle:(_:any,h:any)=>handle=h} as any,{sessionManager:{getSessionSnapshot:()=>metadata,getSession:async()=>session,captureHistory:()=>({session,watermark:12}),getHistoryRevision:()=>'epoch',getPublishedStream:()=>undefined}} as any)
 let max=0,count=0;const api={getSessionHistoryWindow:async(...args:any[])=>{const result=await handle({workspaceId:'w',clientId:'c'},...args);max=Math.max(max,Buffer.byteLength(serializeEnvelope({type:'response',channel:'sessions:historyWindow',id:'x'.repeat(128),result})));count++;return result}};const page=await readWindow(api,'s');expect(page.metadata.preview).toBe(big);expect(page.messages.at(-1)?.content).toBe(big);expect(max).toBeLessThan(127*1024);expect(count).toBeGreaterThan(2);messages.push(user('append'));const older=await readWindow(api,'s',page.older!);expect(older.messages.at(-1)?.id).toBe('m138');messages[0].content='mutation';await expect(readWindow(api,'s',page.older!)).rejects.toThrow('History changed');expect(messages.length).toBe(141)
})
