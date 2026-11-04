import { useId, useState, type ReactNode } from 'react'
import type { parseIncomingAgentEnvelope } from './incoming-agent-envelope'
import { WorkLogDisclosure } from './turn/WorkLog'
import { WORK_LOG_BODY } from './turn/turn-classes'

/** The actual thinking/tool activity disclosure, not a nested user bubble.
 * Local expansion is deliberately independent of changing/streaming content.
 */
export function IncomingAgentMessage({ envelope, label, children, actionsMenu }: {
  envelope: NonNullable<ReturnType<typeof parseIncomingAgentEnvelope>>
  label: string
  children: ReactNode
  actionsMenu?: ReactNode
}) {
  const [isExpanded, setIsExpanded] = useState(false)
  const contentId = useId()
  return (
    <WorkLogDisclosure
      activityCount={1}
      lead={label}
      preview={{ text: envelope.senderId }}
      failedCount={0}
      isExpanded={isExpanded}
      onToggle={() => setIsExpanded(open => !open)}
      contentId={contentId}
      actionsMenu={actionsMenu}
    >
      <div className={`${WORK_LOG_BODY} my-0.5 gap-2 select-text break-words text-copy text-foreground [&_p]:whitespace-pre-wrap`}>
        {children}
      </div>
    </WorkLogDisclosure>
  )
}
