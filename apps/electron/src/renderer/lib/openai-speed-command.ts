import type { OpenAISpeed } from '@craft-agent/shared/agent/openai-speed'
import type { SessionCommand } from '@craft-agent/shared/protocol'

/** The same session RPC is exposed by the Electron and browser client adapters.
 * Do not publish optimistic state here: the canonical metadata event carries the saved request.
 */
export async function requestSessionOpenAISpeed(
  sessionCommand: (sessionId: string, command: Extract<SessionCommand, { type: 'setOpenAISpeed' }>) => Promise<unknown>,
  sessionId: string,
  speed: OpenAISpeed,
  acknowledged?: true,
): Promise<void> {
  const result = await sessionCommand(sessionId, {
    type: 'setOpenAISpeed',
    speed,
    ...(acknowledged === true ? { acknowledged: true } : {}),
  })
  // RPC failures may reject, or use the command's structured failure result.
  if (result && typeof result === 'object') {
    const response = result as { success?: boolean; error?: string }
    if (response.success === false || response.error) {
      throw new Error(response.error || 'The speed request could not be saved. Please try again.')
    }
  }
}
