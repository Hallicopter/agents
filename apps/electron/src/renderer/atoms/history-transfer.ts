import {deserializeEnvelope} from '../../transport/codec'
import type { HistoryCursor, SessionHistoryWindow } from '@craft-agent/shared/protocol'
import type { ElectronAPI } from '../../shared/types'

export async function readWindow(api:Pick<ElectronAPI,'getSessionHistoryWindow'>, id:string, cursor?:HistoryCursor, submissionIds?:string[]):Promise<SessionHistoryWindow> {
  let page = await api.getSessionHistoryWindow(id,cursor,undefined,submissionIds)
  if (!('token' in page)) return page
  const token = page.token, parts:string[] = []
  let offset = 0
  while ('token' in page && page.token === token && page.offset === offset && page.data.length > 0) {
    parts.push(page.data)
    offset += page.data.length
    if (page.next === null) return deserializeEnvelope(parts.join('')).result as SessionHistoryWindow
    if (page.next !== offset) break
    page = await api.getSessionHistoryWindow(id,cursor,{token,offset})
  }
  throw Error('History detail was incomplete')
}
