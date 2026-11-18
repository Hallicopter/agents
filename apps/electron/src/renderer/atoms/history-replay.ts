import type {SessionEvent, SessionHistoryWindow, Session} from '@craft-agent/shared/protocol'
import {processEvent} from '../event-processor/processor'
import type {AgentEvent,SessionState} from '../event-processor/types'

type Event = SessionEvent & {historyEpoch?:string; historySeq?:number}
// Renderer-local inspection state. No consumer may dispatch a send from this map.
const uncertain = new Map<string, Map<string,Session['messages'][number]>>()
const scope = (workspace:string,id:string) => JSON.stringify([workspace,id])
export function unknownDeliveries(workspace:string,id:string) {return [...(uncertain.get(scope(workspace,id))?.values() ?? [])]}
const listeners = new Map<string,Set<() => void>>()
export function subscribeDelivery(workspace:string,id:string,cb:()=>void) {
  const key=scope(workspace,id), group=listeners.get(key) ?? new Set()
  group.add(cb); listeners.set(key,group)
  return () => {group.delete(cb); if (!group.size) listeners.delete(key)}
}
function publish(key:string) { for (const listener of listeners.get(key) ?? []) listener() }
export function discardUnknown(workspace:string,id:string,messageId:string) {
  const key=scope(workspace,id), pending=uncertain.get(key)
  if (!pending?.delete(messageId)) return
  if (!pending.size) uncertain.delete(key)
  publish(key)
}
export function reconcileDelivery(workspace:string,id:string,event:Event) {
  const key=scope(workspace,id), pending=uncertain.get(key)
  if (!pending) return
  const count=pending.size
  if(event.type==='user_message') {pending.delete(event.message.id);if(event.optimisticMessageId) pending.delete(event.optimisticMessageId)}
  if(event.type==='interrupted') for(const cancelled of event.cancelledIds ?? []) pending.delete(cancelled)
  if (!pending.size) uncertain.delete(key)
  if (count!==pending.size) publish(key)
}
// Transport can replay only its recent 500 frames. A retired sequence is
// never eligible again, including after its individual claim is compacted.
const seenEffects=new Map<string,{epoch:string; high:number; seen:Set<number>}>()
// Cross-initialization replay guard. Do not retain one ledger per departed
// workspace, but keep claims that can still arrive in the transport ring.
const recentClaims = new Set<string>()
const retiredEpochs = new Set<string>()
function remember(set:Set<string>, key:string) {
  set.add(key)
  if(set.size>512) set.delete(set.values().next().value!)
}
function replaceEffectEpoch(key:string,epoch:string) {
  const previous=seenEffects.get(key)
  if(previous && previous.epoch!==epoch) {
    remember(retiredEpochs,JSON.stringify([key,previous.epoch]))
    seenEffects.delete(key)
  }
}
export function claimHistoryEffect(workspace:string,event:Event) {
  if((event.type!=='complete' && event.type!=='interrupted') || !event.historyEpoch || event.historySeq===undefined) return true
  const key=scope(workspace,event.sessionId), seq=event.historySeq
  if(retiredEpochs.has(JSON.stringify([key,event.historyEpoch]))) return false
  replaceEffectEpoch(key,event.historyEpoch)
  const ledger=seenEffects.get(key) ?? {epoch:event.historyEpoch,high:0,seen:new Set<number>()}
  const claim=JSON.stringify([key,event.historyEpoch,seq])
  if(recentClaims.has(claim)) return false
  if (ledger.epoch!==event.historyEpoch || seq<=ledger.high-512 || ledger.seen.has(seq)) return false
  remember(recentClaims,claim)
  ledger.high=Math.max(ledger.high,seq)
  for (const n of ledger.seen) if(n<=ledger.high-512) ledger.seen.delete(n)
  ledger.seen.add(seq);seenEffects.set(key,ledger);return true
}
const journals = new Map<string,Event[]>()
const installed = new Map<string,{epoch:string;seq:number}>()
export function beginHistory(id:string) {const events:Event[]=[]; journals.set(id,events); return events}
export function endHistory(id:string,events:Event[]) {if(journals.get(id)===events) journals.delete(id)}
export function forgetHistory(id?:string,workspace?:string) {
  // Delete releases this scope. A workspace reset keeps only actual unresolved
  // payloads; never discard recoverable text just to meet a cache limit.
  if (id && workspace) {const key=scope(workspace,id); seenEffects.delete(key); uncertain.delete(key); publish(key)}
  else if (!id) seenEffects.clear()
  if(id===undefined){installed.clear();journals.clear()}else{installed.delete(id);journals.delete(id)}}
export function observeHistory(id:string,event:Event) {
  const stamp=installed.get(id)
  if(stamp && event.historyEpoch===stamp.epoch && event.historySeq!==undefined && event.historySeq<=stamp.seq) return false
  // Advance only across consecutive live events. A jump is not proof that
  // intervening frames were delivered; never mark the missing range covered.
  if (stamp && event.historyEpoch === stamp.epoch && event.historySeq === stamp.seq + 1) {
    stamp.seq = event.historySeq
  }
  journals.get(id)?.push(event)
  return true
}
export function rebaseHistory(page:SessionHistoryWindow, events:Event[], current:Session|null) {
  const session = {...page.metadata,messages:[...page.messages]}
  const tail = session.messages.findLast(m=>m.isStreaming)
  let state:SessionState={session,streaming:tail?{content:tail.content,turnId:tail.turnId}:null}
  let seq=page.watermark ?? 0
  for(const event of events){
    // Caller-only post-ACK error/complete are explicitly not part of managed history.
    if (event.historySeq===undefined && (event.type==='error' || event.type==='complete')) {state=processEvent(state,event as AgentEvent).state;continue}
    if(page.watermark===undefined || event.historyEpoch!==page.epoch || event.historySeq===undefined) throw Error('History stream changed; refresh recent messages')
    if(event.historySeq<=seq) continue
    if(event.historySeq!==seq+1) throw Error('History stream gap; refresh recent messages')
    seq=event.historySeq
    if(!['session_created','session_deleted','task_activity'].includes(event.type)) state=processEvent(state,event as AgentEvent).state
  }
  // A send may still be in transit. Never infer acceptance from the prompt text and never resend.
  quarantinePending(state.session,current,events,page.submissionState)
  if(page.epoch && page.watermark!==undefined) {
    const key=scope(session.workspaceId,session.id)
    replaceEffectEpoch(key,page.epoch)
    installed.set(session.id,{epoch:page.epoch,seq})
  }
  return state.session
}

export function quarantinePending(session:Session,current:Session|null,events:Event[],dispositions?:SessionHistoryWindow['submissionState']) {
  const key=scope(session.workspaceId,session.id)
  const pending=uncertain.get(key) ?? new Map()
  if(current?.workspaceId===session.workspaceId) for(const m of current.messages) if(m.role==='user' && (m.isPending || m.isQueued)) pending.set(m.id,m)
  uncertain.set(key,pending)
  for(const id of [...dispositions?.accepted ?? [], ...dispositions?.cancelled ?? []]) pending.delete(id)
  for(const m of session.messages) pending.delete(m.id)
  for(const event of events) reconcileDelivery(session.workspaceId,session.id,event)
  if(!pending.size) uncertain.delete(key)
  publish(key)
}
