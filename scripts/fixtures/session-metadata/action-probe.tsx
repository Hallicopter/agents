// Synthetic concurrent-render/action probe only; no API/provider calls.
import React, { useState } from 'react'
import { TurnCard, type ActivityItem } from '@craft-agent/ui'
const activities: ActivityItem[] = []
const response = { text: 'Synthetic commit-safe action probe.', messageId: 'probe-response' }
const never = new Promise<never>(() => {})
function PendingProbe({ blocked }: { blocked: boolean }) {
  if (blocked) {
    ;(globalThis as any).__frontProfile.probeAttempts++
    throw never
  }
  return null
}
export function ActionProbe() {
  const [version, setVersion] = useState(1)
  const diag = (globalThis as any).__frontProfile
  diag.prepareUncommitted = () => React.startTransition(() => setVersion(2))
  diag.commitProbe = (next: number) => setVersion(next)
  return <React.Suspense fallback={<div>Pending probe</div>}>
    <TurnCard sessionId={version === 5 ? 'probe-next' : 'probe'} turnId="probe-turn"
      activities={activities} response={response} isStreaming={false} isComplete
      onBranch={version === 4 ? undefined : () => { diag.probeCalls.push(version) }} />
    <PendingProbe blocked={version === 2} />
    <span data-probe-version={version}>Probe {version}</span>
  </React.Suspense>
}
