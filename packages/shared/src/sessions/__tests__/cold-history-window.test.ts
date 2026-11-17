import { test, expect } from 'bun:test'
import { mkdtemp, writeFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {readColdHistoryWindow} from '../cold-history-window'
test('bounded cold tail and complete older traversal across unicode byte boundaries; atomic replacement invalidates',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cold-window-')),path=join(dir,'session.jsonl');try{
 const rows=Array.from({length:3508},(_,i)=>({id:String(i),type:'user',content:'😀'.repeat(512)+'{{SESSION_PATH}}'})); await writeFile(path,['{}',...rows.map(r=>JSON.stringify(r))].join('\n')+'\n');let p=await readColdHistoryWindow(path);const cursor=p.older!;const ids:string[]=[];do{expect(p.bytesRead).toBeLessThanOrEqual(96*1024);expect(p.blocked).toBe(false);ids.unshift(...p.messages.map(m=>m.id));expect(p.messages[0]?.content.endsWith(dir)).toBe(true);if(!p.older)break;p=await readColdHistoryWindow(path,p.older)}while(true);expect(ids).toEqual(rows.map(r=>r.id));await writeFile(path+'.new','{}\n');await rename(path+'.new',path);await expect(readColdHistoryWindow(path,cursor)).rejects.toThrow('changed')
 }finally{await rm(dir,{recursive:true,force:true})}
})
test('oversized last row blocks explicitly, corrupt JSON rejects',async()=>{const dir=await mkdtemp(join(tmpdir(),'cold-window-')),path=join(dir,'session.jsonl');try{await writeFile(path,'{}\n'+JSON.stringify({type:'tool',id:'t',content:'x'.repeat(200000)})+'\n');const p=await readColdHistoryWindow(path);expect(p.blocked).toBe(true);expect(p.older).toBeNull();await writeFile(path,'{}\n{"truncated"');await expect(readColdHistoryWindow(path)).rejects.toThrow()}finally{await rm(dir,{recursive:true,force:true})}})
