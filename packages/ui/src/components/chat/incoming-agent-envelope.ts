/** Legacy display fallback only. This is not proof of origin or authorization.
 * Message/StoredMessage currently carry no trusted inter-agent provenance.
 * Keep the transport text untouched for history, copying and model prompts.
 */
export function parseIncomingAgentEnvelope(content: string) {
  // Deliberately anchored, exact transport punctuation/newlines, matching sender
  // in the reply instruction. Never trim: quoted/code/embedded envelopes aren't
  // incoming envelopes. Names may contain parentheses, but not newlines.
  const match = /^\[Message from session "([A-Za-z0-9][A-Za-z0-9_-]*)" \(([^\r\n]+)\)\]\nUse send_agent_message with sessionId "\1" to reply\.\n\n---\n\n([\s\S]+)$/.exec(content)
  if (!match || !match[3]!.trim()) return null
  return {
    senderId: match[1]!,
    senderName: match[2]!,
    preview: match[3]!.trim().split('\n')[0]!.slice(0, 120),
  }
}
