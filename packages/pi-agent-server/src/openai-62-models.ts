import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import { addMissingOpenAI62Models } from '../../shared/src/config/openai-62-models.ts';

export function registerOpenAI62Models(registry: ModelRegistry): void {
  for (const provider of ['openai', 'openai-codex']) {
    const existing = registry.getAll().filter(model => model.provider === provider);
    if (!existing.length) throw new Error(`Cannot register GPT-6.2 without built-in ${provider} provider`);
    const models = addMissingOpenAI62Models(provider, existing);
    if (models.length === existing.length) continue;
    // Extension models replace the provider's model list: keep all entries and
    // inherit native OAuth/API transport, never install replacement auth or URLs.
    registry.registerProvider(provider, { models });
  }
}
