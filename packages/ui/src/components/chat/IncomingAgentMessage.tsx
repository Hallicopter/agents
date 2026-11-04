import type { ReactNode } from 'react'
import type { parseIncomingAgentEnvelope } from './incoming-agent-envelope'

/** Native details gives keyboard expansion without mutating transcript state. */
export function IncomingAgentMessage({ envelope, label, children }: {
  envelope: NonNullable<ReturnType<typeof parseIncomingAgentEnvelope>>
  label: string
  children: ReactNode
}) {
  return (
    <details className="group/envelope">
      <summary className="cursor-pointer rounded-sm text-label focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
        <span className="break-all font-medium">{label}</span>
        <span className="ml-1 text-tertiary break-all">({envelope.senderId})</span>
        <span className="mt-1 block text-copy text-secondary group-open/envelope:hidden">{envelope.preview}</span>
      </summary>
      <div className="mt-2 border-t border-separator pt-2">{children}</div>
    </details>
  )
}
