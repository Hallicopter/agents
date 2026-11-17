import type {SessionEvent, SessionHistoryWindow, Session} from '@craft-agent/shared/protocol'
import {processEvent} from '../event-processor/processor'
import type {AgentEvent,SessionState} from '../event-processor/types'

type Event = SessionEvent & {historyEpoch?:string; historySeq?:number}
const journals = new Map<string,Event[]>()
const installed = new Map<string,{epoch:string;seq:number}>()
export function beginHistory(id:string) {const events:Event[]=[]; journals.set(id,events); return events}
export function endHistory(id:string,events:Event[]) {if(journals.get(id)===events) journals.delete(id)}
export function forgetHistory(id?:string) {if(id===undefined){installed.clear();journals.clear()}else{installed.delete(id);journals.delete(id)}}
export function observeHistory(id:string,event:Event) {
  const stamp=installed.get(id)
  if(stamp && event.historyEpoch===stamp.epoch && event.historySeq!==undefined && event.historySeq<=stamp.seq) return false
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
  const known=new Set(state.session.messages.map(m=>m.id))
  for(const m of current?.messages??[]) if(m.role==='user' && m.isPending && !known.has(m.id)) state.session={...state.session,messages:[...state.session.messages,m]}
  if(page.epoch && page.watermark!==undefined) installed.set(session.id,{epoch:page.epoch,seq})
  return state.session
}
