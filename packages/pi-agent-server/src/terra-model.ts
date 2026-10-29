import type { ModelRegistry } from '@earendil-works/pi-coding-agent';

// Official upstream definition, verified 2026-10-26:
// https://github.com/earendil-works/pi/blob/main/packages/ai/scripts/generate-models.ts
// Temporary additive bridge for the installed Pi 1.1.0 catalog; never override a newer definition.
export const TERRA_ID = 'gpt-6.1-terra';
export function requiresExactModel(id?: string): boolean {
  return id?.replace(/^pi\//, '') === TERRA_ID;
}

export function registerTerraModel(registry: ModelRegistry): void {
  if (registry.find('openai-codex', TERRA_ID)) return;
  const existing = registry.getAll().filter(model => model.provider === 'openai-codex');
  if (!existing.length) throw new Error('Cannot register Terra without the built-in Codex provider');
  // Extension models replace the list, so retain every existing definition.
  // Omitting auth/baseUrl overrides preserves the built-in OAuth implementation.
  registry.registerProvider('openai-codex', {
    models: [...existing, {
      id: TERRA_ID,
      name: 'GPT-6.1 Terra',
      api: 'openai-codex-responses',
      baseUrl: 'https://chatgpt.com/backend-api',
      reasoning: true,
      input: ['text', 'image'],
      cost: {
        input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25,
        tiers: [{ inputTokensAbove: 272000, input: 2, output: 7.5, cacheRead: 0.1, cacheWrite: 2.5 }],
      },
      contextWindow: 500000,
      maxTokens: 128000,
      thinkingLevelMap: { off: 'none', minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
    }],
  });
}

export function verifyTerraResponse(model: string | undefined, provider: string | undefined): void {
  if (model !== TERRA_ID || provider !== 'openai-codex') {
    throw new Error(`Exact Terra response required; received model=${model ?? 'unknown'}, provider=${provider ?? 'unknown'}`);
  }
}
