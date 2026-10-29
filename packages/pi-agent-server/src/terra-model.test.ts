import { describe, expect, it } from 'bun:test';
import { ModelRuntime, ModelRegistry } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import { registerTerraModel, requiresExactModel, verifyTerraResponse } from './terra-model.ts';
import { queryMiniModel } from './mini-model-query.ts';

describe('exact Terra compatibility bridge', () => {
  it('retains every existing Codex model and OAuth without affecting other providers', async () => {
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false });
    const registry = new ModelRegistry(runtime);
    const before = registry.getAll();
    const oauth = runtime.getProvider('openai-codex')?.auth.oauth;
    registerTerraModel(registry);
    for (const model of before) expect(registry.find(model.provider, model.id)).toEqual(model);
    expect(runtime.getProvider('openai-codex')?.auth.oauth).toBeDefined();
    expect(runtime.getProvider('openai-codex')?.auth.oauth?.name).toBe(oauth?.name);
    const terra = registry.find('openai-codex', 'gpt-6.1-terra');
    expect(terra?.contextWindow).toBe(500000);
    expect(terra?.cost.input).toBe(1);
    expect(terra?.thinkingLevelMap?.off).toBe('none');
    const count = registry.getAll().length;
    registerTerraModel(registry);
    expect(registry.getAll().length).toBe(count);
  });

  it('never retries a rejected Terra request on another model', async () => {
    const attempts: string[] = [];
    await expect(queryMiniModel({ model: 'pi/gpt-6.1-terra', sessionModel: 'pi/gpt-6-astra', authProvider: 'openai-codex', modelRegistry: {} as ModelRegistry, preferCustomEndpoint: false }, async model => {
      attempts.push(model);
      throw new Error("The 'gpt-6.1-terra' model is not supported");
    })).rejects.toThrow('not supported');
    expect(attempts).toEqual(['pi/gpt-6.1-terra']);
  });

  it('rejects unknown or different returned attribution', () => {
    expect(requiresExactModel('pi/gpt-6.1-terra')).toBe(true);
    expect(requiresExactModel('pi/gpt-6-astra')).toBe(false);
    expect(() => verifyTerraResponse(undefined, undefined)).toThrow();
    expect(() => verifyTerraResponse('gpt-6-astra', 'openai-codex')).toThrow();
    expect(() => verifyTerraResponse('gpt-6.1-terra', 'openai-codex')).not.toThrow();
  });
});
