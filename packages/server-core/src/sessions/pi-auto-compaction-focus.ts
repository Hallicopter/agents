/** Use the host's session metadata, never labels or role claims found in a message or summary. */
export function piAutoCompactionFocusForSession(session: {
  labels?: readonly string[];
  triggeredBy?: unknown;
}): 'puck' | undefined {
  const labels = session.labels ?? [];
  if (!session.triggeredBy && labels.includes('puck') &&
    !labels.includes('puck-subagent') && !labels.includes('puck-automation')) {
    return 'puck';
  }
  return undefined;
}
