import type { FileAttachment } from '../../shared/types'

type Snapshot = { text: string; attachments: FileAttachment[] }
type Editor = { snapshot(): Snapshot; install(draft: Snapshot): void }
// Registration order is stable during this synchronous transaction. Read every
// mounted copy before publishing any value back into the shared draft cache.
export function registerEditor(id: string, editor: Editor) {
  const collect = (event: Event) => {
    const {sessionId, group} = (event as CustomEvent<{sessionId:string;group: Editor[]}>).detail
    if (id === sessionId) group.push(editor)
  }
  window.addEventListener('craft:restore-input',collect)
  return () => window.removeEventListener('craft:restore-input',collect)
}
export function restoreEditors(id: string, text: string): boolean {
  const group: Editor[] = []
  window.dispatchEvent(new CustomEvent('craft:restore-input',{detail:{sessionId:id,group}}))
  if (!group.length) return false
  const snapshots = [...group].map(editor => editor.snapshot())
  const attachments = [...new Map(snapshots.flatMap(s => s.attachments.map(a => [JSON.stringify([a.path,a.name,a.size,a.text,a.base64]),a] as const))).values()]
  const draft = { text: [...new Set(snapshots.map(s => s.text).filter(Boolean)), text].join('\n\n'), attachments }
  for (const editor of group) editor.install(draft)
  return true
}
