import type {SessionEvent, SessionHistoryWindow, Session} from '@craft-agent/shared/protocol'
import {processEvent} from '../event-processor/processor'
import type {AgentEvent,SessionState} from '../event-processor/types'

type Event = SessionEvent & {historyEpoch?:string; historySeq?:number}
// Renderer-local inspection state. No consumer may dispatch a send from this map.
const uncertain = new Map<string, Map<string,Session['messages'][number]>>()
const scope = (workspace:string,id:string) => JSON.stringify([workspace,id])
export function unknownDeliveries(workspace:string,id:string) {return [...(uncertain.get(scope(workspace,id))?.values() ?? [])]}
export function reconcileDelivery(workspace:string,id:string,event:Event) {
  const pending = uncertain.get(scope(workspace,id))
  if(event.type==='user_message') {pending?.delete(event.message.id);if(event.optimisticMessageId) pending?.delete(event.optimisticMessageId)}
  if(event.type==='interrupted') for(const cancelled of event.cancelledIds ?? []) pending?.delete(cancelled)
}
const seenEffects=new Map<string,Set<number>>()
export function claimHistoryEffect(workspace:string,event:Event) {
  if((event.type!=='complete' && event.type!=='interrupted') || !event.historyEpoch || event.historySeq===undefined) return true
  const key=JSON.stringify([workspace,event.sessionId,event.historyEpoch])
  const seen=seenEffects.get(key) ?? new Set<number>()
  if(seen.has(event.historySeq)) return false
  seen.add(event.historySeq);seenEffects.set(key,seen);return true
}
const journals = new Map<string,Event[]>()
const installed = new Map<string,{epoch:string;seq:number}>()
export function beginHistory(id:string) {const events:Event[]=[]; journals.set(id,events); return events}
export function endHistory(id:string,events:Event[]) {if(journals.get(id)===events) journals.delete(id)}
export function forgetHistory(id?:string) {if(id===undefined){installed.clear();journals.clear()}else{installed.delete(id);journals.delete(id)}}
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
  if(page.epoch && page.watermark!==undefined) installed.set(session.id,{epoch:page.epoch,seq})
  return state.session
}

export function quarantinePending(session:Session,current:Session|null,events:Event[],dispositions?:SessionHistoryWindow['submissionState']) {
  const key=scope(session.workspaceId,session.id)
  const pending=uncertain.get(key) ?? new Map()
  if(current?.workspaceId===session.workspaceId) for(const m of current.messages) if(m.role==='user' && m.isPending) pending.set(m.id,m)
  uncertain.set(key,pending)
  for(const id of [...dispositions?.accepted ?? [], ...dispositions?.cancelled ?? []]) pending.delete(id)
  for(const m of session.messages) pending.delete(m.id)
  for(const event of events) reconcileDelivery(session.workspaceId,session.id,event)
  if(!pending.size) uncertain.delete(key)
}
