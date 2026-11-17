import type { Api, Model } from '@earendil-works/pi-ai';

// Additive catalog bridge until Pi includes these exact upstream IDs. Verified 2026-11-17:
// https://developers.openai.com/api/docs/models/gpt-6.2-astra
// https://developers.openai.com/api/docs/models/gpt-6.2-sol
// https://learn.chatgpt.com/docs/models (Codex default context windows)
// https://developers.openai.com/api/docs/guides/latest-model (none/minimal -> low)
// No aliases, provider/auth overrides, defaults, or speed-tier activation.
export const OPENAI_62_IDS = ['gpt-6.2-astra', 'gpt-6.2-sol'] as const;

export function isOpenAI62Model(id?: string): boolean {
  return OPENAI_62_IDS.some(candidate => candidate === id?.replace(/^pi\//, ''));
}

export function getOpenAI62Models(provider: string): Model<Api>[] {
  if (provider !== 'openai' && provider !== 'openai-codex') return [];
  return OPENAI_62_IDS.map(id => {
    const astra = id === 'gpt-6.2-astra';
    const input = astra ? 8 : 2;
    const output = astra ? 40 : 10;
    const cacheRead = astra ? 0.4 : 0.1;
    const cacheWrite = astra ? 10 : 2.5;
    return {
      id,
      name: astra ? 'GPT-6.2 Astra' : 'GPT-6.2 Sol',
      provider,
      api: provider === 'openai' ? 'openai-responses' : 'openai-codex-responses',
      baseUrl: provider === 'openai' ? 'https://api.openai.com/v1' : 'https://chatgpt.com/backend-api',
      reasoning: true,
      input: ['text', 'image'],
      // Standard API-rate estimates, not subscription allowance/credit accounting.
      cost: { input, output, cacheRead, cacheWrite,
        tiers: [{ inputTokensAbove: 272000, input: input * 2, output: output * 1.5,
          cacheRead: cacheRead * 2, cacheWrite: cacheWrite * 2 }] },
      contextWindow: provider === 'openai' ? 1050000 : astra ? 272000 : 500000,
      maxTokens: 128000,
      // These models reject 'none'. Off/minimal use the documented minimum, low.
      thinkingLevelMap: { off: 'low', minimal: 'low', low: 'low', medium: 'medium',
        high: 'high', xhigh: 'xhigh', max: 'max' },
      // The6.2 API no longer accepts prompt_cache_retention. The installed SDK
      // already supports the replacement prompt_cache_options format behind this flag.
      compat: { supportsExplicitPromptCacheMode: true },
    };
  });
}

export function addMissingOpenAI62Models<T extends Model<Api>>(provider: string, existing: T[]): (T | Model<Api>)[] {
  return [...existing, ...getOpenAI62Models(provider).filter(model => !existing.some(m => m.id === model.id))];
}
