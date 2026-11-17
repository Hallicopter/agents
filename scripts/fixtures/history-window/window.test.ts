import {test,expect} from 'bun:test'
import {page,detail,LIMIT,type Snapshot} from './window'
const messages=Array.from({length:3508},(_,i)=>({id:`m${i}`,role:'tool' as const,content:'\"😀'.repeat(i===3507?80000:400),timestamp:i,toolUseId:`t${i}`,parentToolUseId:i%2?`t${i-1}`:undefined}))
const s:Snapshot={scope:'fixture/w/s',revision:'one',messages}
test('backward pages preserve all IDs, across byte and count limits; never masquerade as a Session',()=>{
 let p=page(s);const ids:string[]=[];expect(p.entries.at(-1)?.kind).toBe('deferred');while(true){expect(Buffer.byteLength(JSON.stringify(p))).toBeLessThan(LIMIT);ids.unshift(...p.entries.map(r=>r.kind==='message'?r.message.id:r.id));if(!p.older)break;p=page(s,p.older)}expect(ids).toEqual(messages.map(m=>m.id))
})
test('explicit oversized retrieval round trips unicode and quoted content',()=>{let offset:number|null=0,raw='';do{const chunk=detail(s,s,'m3507',offset);expect(Buffer.byteLength(JSON.stringify(chunk))).toBeLessThan(LIMIT);raw+=chunk.text;offset=chunk.next}while(offset!==null);expect(JSON.parse(raw)).toEqual(messages[3507])})
test('reject stale revisions, wrong scope, deleted anchors and invalid offsets',()=>{const c=page(s).older!;for(const snap of [{...s,revision:'changed'},{...s,scope:'other'}]) {expect(()=>page(snap,c)).toThrow();expect(()=>detail(snap,c,'m1',0)).toThrow()};expect(()=>page(s,{...c,beforeId:'missing'})).toThrow();expect(()=>detail(s,s,'m1',-1)).toThrow();expect(page(s,undefined,'m2').entries).toHaveLength(3)})
