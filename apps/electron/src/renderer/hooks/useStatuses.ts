/**
 * useStatuses Hook
 *
 * React hook to load and manage workspace statuses.
 * Auto-refreshes when workspace changes.
 */

import { useWorkspaceMetadata, type WorkspaceMetadataSource } from './useWorkspaceMetadata'
import type { StatusConfig } from '@craft-agent/shared/statuses'
import { clearIconCache } from '@/config/session-status-config'

export interface UseStatusesResult {
  statuses: StatusConfig[]
  isLoading: boolean
  error: string | null
  refresh: () => Promise<void>
}

/**
 * Load statuses for a workspace via IPC
 * Auto-refreshes when workspaceId changes
 *
 * To detect agent edits to status config files, you could:
 * - Poll periodically (simple)
 * - Use file watcher in main process (more complex but real-time)
 */
const statusesSource: WorkspaceMetadataSource<StatusConfig> = {
  load: workspaceId => window.electronAPI.listStatuses(workspaceId),
  subscribe: onChange => window.electronAPI.onStatusesChanged(workspaceId => {
    clearIconCache()
    onChange(workspaceId)
  }),
}

export function useStatuses(workspaceId: string | null): UseStatusesResult {
  const { data: statuses, isLoading, error, refresh } = useWorkspaceMetadata(workspaceId, statusesSource)
  return { statuses, isLoading, error, refresh }
}
