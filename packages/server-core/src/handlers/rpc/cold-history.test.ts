import { test, expect } from 'bun:test'
import { registerColdHistoryHandler } from './cold-history'
import type { HandlerFn } from '../../transport/types'
function setup() {
  let scope='w', reads=0, text='hello', gate:Promise<void>|undefined
  let handle!:HandlerFn
  registerColdHistoryHandler({handle:(_ch:string,fn:HandlerFn)=>{handle=fn}} as any,{sessionManager:{getSessionSnapshot:()=>({workspaceId:scope}),readColdHistoryPage:async()=>{reads++;await gate;return {messages:[{id:'m',timestamp:1,type:'user',content:text}],older:{revision:'test',end:10}}}}} as any)
  return {get reads(){return reads},setScope:(s:string)=>scope=s,setText:(s:string)=>text=s,setGate:(g:Promise<void>)=>gate=g,call:(client='c',workspace:string|null='w',id='s',next?:string)=>handle({clientId:client,workspaceId:workspace,webContentsId:null},id,next)}
}
test('cursor cannot cross connection/session/workspace, be replayed or silently restart',async()=>{const f=setup();await expect(f.call('c',null)).rejects.toThrow();await expect(f.call('c','wrong')).rejects.toThrow();expect(f.reads).toBe(0);const p=await f.call();expect(p.messages[0].role).toBe('user');await expect(f.call('new','w','s',p.next)).rejects.toThrow();await expect(f.call('c','w','other',p.next)).rejects.toThrow();await f.call('c','w','s',p.next);await expect(f.call('c','w','s',p.next)).rejects.toThrow()})
test('reject scope change during IO and prevent oversized escaped frame',async()=>{const f=setup();let unlock!:()=>void;f.setGate(new Promise(r=>unlock=r));const p=f.call();f.setScope('changed');unlock();await expect(p).rejects.toThrow();f.setScope('w');f.setText('\u0000'.repeat(100_000));expect(await f.call()).toEqual({kind:'unavailable',reason:'oversized'})})
