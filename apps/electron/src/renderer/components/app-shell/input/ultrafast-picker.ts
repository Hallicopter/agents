import type { LlmConnectionWithStatus } from '@config/llm-connections'
import type { ModelDefinition } from '@config/models'

/** Session picker only; do not advertise an implicit default or utility model. */
export function pickerModels(models: Array<string | ModelDefinition>, conn?: LlmConnectionWithStatus | null) {
  if (!conn?.isAuthenticated || conn.providerType !== 'pi' || conn.authType !== 'oauth' || conn.piAuthProvider !== 'openai-codex' || conn.baseUrl || conn.customEndpoint) return models
  return models.flatMap(m => (typeof m === 'string' ? m : m.id) === 'pi/gpt-6.2-sol'
    ? [m, { id: 'pi/gpt-6.2-sol-ultrafast', provider: 'pi' as const, name: 'GPT-6.2-SOUL Ultrafast', shortName: 'Ultrafast', description: 'Requests the Ultrafast service tier', contextWindow: 500000, supportsThinking: true }]
    : [m])
}
