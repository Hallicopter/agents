// Synthetic worst case: child tools near the end of one long assistant turn.
import { groupMessagesByTurn } from '../../../packages/ui/src/components/chat/turn-utils'
import type { Message } from '@craft-agent/core'
const messages: Message[] = Array.from({ length: 3500 }, (_, i) => ({
  id: `msg${i}`, timestamp: i, role: 'tool', toolName: 'Read', toolUseId: `tool${i}`,
  parentToolUseId: i % 2 ? `tool${i-1}` : undefined, content: 'synthetic', toolStatus: 'completed',
}))
const times: number[] = []
for (let i = 0; i < 24; i++) {
  const start = performance.now()
  const [turn] = groupMessagesByTurn(messages, { isSessionProcessing: true })
  const elapsed = performance.now() - start
  if (turn?.type !== 'assistant' || turn.activities.some((a, i) => a.depth !== i % 2)) throw Error('depth mismatch')
  if (i >= 5) times.push(elapsed)
}
console.log(JSON.stringify({ messages: messages.length, samples: times.length, medianMs: times.sort((a,b)=>a-b)[9] }))
