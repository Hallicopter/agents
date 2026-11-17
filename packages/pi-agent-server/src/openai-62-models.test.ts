import { describe, expect, it } from 'bun:test';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import { stream as codexStream } from '@earendil-works/pi-ai/api/openai-codex-responses';
import { stream as apiStream } from '@earendil-works/pi-ai/api/openai-responses';
import { getOpenAI62Models, OPENAI_62_IDS, addMissingOpenAI62Models } from '../../shared/src/config/openai-62-models.ts';
import { getAllPiModels, getPiModelsForAuthProvider } from '../../shared/src/config/models-pi.ts';
import { registerTerraModel } from './terra-model.ts';
import { registerOpenAI62Models } from './openai-62-models.ts';

const context = { messages: [{ role: 'user' as const, content: 'offline test', timestamp: 0 }] };
// Synthetic parser fixture, never sent anywhere; onPayload always throws before networking.
const fixture = `test.${btoa(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'offline-test' } }))}.test`;

async function capture(stream: Function, model: any, extra: Record<string, unknown> = {}) {
  let body: any;
  let networkCalls = 0;
  const result = await stream(model, context, { apiKey: model.provider === 'openai-codex' ? fixture : 'sk-offline-test',
    maxRetries: 0, ...extra,
    fetch: () => { networkCalls++; throw new Error('NETWORK FORBIDDEN'); },
    onPayload: (payload: unknown) => { body = JSON.parse(JSON.stringify(payload)); throw new Error('OFFLINE PAYLOAD CAPTURE'); },
  }).result();
  expect(result.stopReason).toBe('error');
  expect(result.errorMessage).toContain('OFFLINE PAYLOAD CAPTURE');
  expect(networkCalls).toBe(0);
  expect(body).toBeDefined();
  return body;
}

describe('GPT-6.2 additive catalog bridge', () => {
  it('preserves all models, Terra, OAuth and provider URLs; is idempotent', async () => {
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(),
      modelsPath: null, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false });
    const registry = new ModelRegistry(runtime);
    registerTerraModel(registry);
    const before = registry.getAll();
    const oauth = runtime.getProvider('openai-codex')?.auth.oauth;
    registerOpenAI62Models(registry);
    for (const model of before) expect(registry.find(model.provider, model.id)).toEqual(model);
    expect(runtime.getProvider('openai-codex')?.auth.oauth?.name).toBe(oauth?.name);
    expect(runtime.getProvider('openai-codex')?.auth.oauth).toBeDefined();
    for (const provider of ['openai', 'openai-codex']) {
      for (const id of OPENAI_62_IDS) {
        const model = registry.find(provider, id)!;
        expect(model.id).toBe(id);
        expect(model.maxTokens).toBe(128000);
        expect(model.thinkingLevelMap?.off).toBe('low');
      }
    }
    expect(registry.find('openai-codex', 'gpt-6.2-sol')?.contextWindow).toBe(500000);
    expect(registry.find('openai-codex', 'gpt-6.2-astra')?.contextWindow).toBe(272000);
    expect(registry.find('openai', 'gpt-6.2-sol')?.contextWindow).toBe(1050000);
    const after = registry.getAll();
    registerOpenAI62Models(registry);
    expect(registry.getAll()).toEqual(after);
  });

  it('never overwrites newer upstream metadata, offers exact dropdown IDs only for supported providers', () => {
    const upstream = { ...getOpenAI62Models('openai')[0]!, name: 'Upstream authoritative metadata' };
    expect(addMissingOpenAI62Models('openai', [upstream])[0]).toBe(upstream);
    for (const provider of ['openai', 'openai-codex']) {
      const ids = getPiModelsForAuthProvider(provider).map(m => m.id);
      for (const id of OPENAI_62_IDS) expect(ids.filter(m => m === `pi/${id}`)).toHaveLength(1);
    }
    for (const id of OPENAI_62_IDS) expect(getAllPiModels().some(m => m.id === `pi/${id}`)).toBe(true);
    expect(getOpenAI62Models('google')).toEqual([]);
    expect(getPiModelsForAuthProvider('google').some(m => m.id.includes('gpt-6.2'))).toBe(false);
  });

  it('serializes exact model IDs with safe minimum reasoning and no premium tier by default', async () => {
    for (const provider of ['openai', 'openai-codex']) {
      for (const model of getOpenAI62Models(provider)) {
        const body = await capture(provider === 'openai' ? apiStream : codexStream, model, { cacheRetention: 'long' });
        expect(body.model).toBe(model.id);
        expect(body.reasoning.effort).toBe('low');
        expect(body.service_tier).toBeUndefined();
        expect(body.temperature).toBeUndefined();
        expect(body.prompt_cache_retention).toBeUndefined();
        if (provider === 'openai') expect(body.prompt_cache_options).toEqual({ ttl: '30m' });
      }
    }
  });

});
