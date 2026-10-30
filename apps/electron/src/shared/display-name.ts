/** Cosmetic fork label only. Keep runtime/data/protocol identity unchanged. */
export const FORK_DISPLAY_NAME = 'Scoville Agents'
export const LEGACY_RUNTIME_NAME = 'Craft Agents'

/** Custom/multi-instance names remain exactly as configured. */
export function displayAppName(runtimeName: string): string {
  return runtimeName === LEGACY_RUNTIME_NAME ? FORK_DISPLAY_NAME : runtimeName
}
