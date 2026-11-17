import { describe, expect, it } from 'bun:test';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { createAgentSession, createExtensionRuntime, SessionManager, SettingsManager, type ModelRuntime, type ResourceLoader } from '@earendil-works/pi-coding-agent';
import { streamSimple as codexSimple, getOpenAICodexWebSocketDebugStats, resetOpenAICodexWebSocketDebugStats } from '@earendil-works/pi-ai/api/openai-codex-responses';
import { getOpenAI62Models } from '../../shared/src/config/openai-62-models.ts';
import { assertOpenAISpeedAllowed, getOpenAISpeedOptions, getOpenAISpeedMultipliers,
  getOpenAISpeedWarning, ULTRAFAST_PROMO_END, type OpenAISpeed } from '../../shared/src/agent/openai-speed.ts';
import { configureOpenAISpeedBudget, wrapOpenAISpeedStream, type SpeedReport } from './openai-speed.ts';
import { capturedSpeedEvents } from './test-fixtures/openai-speed-captured';

const context = { messages: [{ role: 'user' as const, content: 'offline fixture', timestamp: 0 }] };
const model = getOpenAI62Models('openai-codex').find(m => m.id === 'gpt-6.2-sol')!;
const selected = (speed: OpenAISpeed, m = model) => ({ speed, model: m.id, provider: m.provider });
const baseMessage = (cost = 10): AssistantMessage => ({ role: 'assistant', content: [{ type: 'text', text: 'fixture' }],
  model: model.id, provider: model.provider, api: model.api, stopReason: 'stop', timestamp: 0,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: cost / 2, output: cost / 2, cacheRead: 0, cacheWrite: 0, total: cost } } });

function fakeNative(applied?: string, payloadModel = model.id) {
  const payloads: any[] = [];
  const original: StreamFn = async (m, _ctx, options) => {
    payloads.push(await options?.onPayload?.({ model: payloadModel, preserve: 'existing hook' }, m));
    await options?.onProviderStreamEvent?.({ type: 'response.created', response: { service_tier: 'ultrafast' } }, m);
    await options?.onProviderStreamEvent?.({ type: 'response.completed', response: applied ? { service_tier: applied } : {} }, m);
    const stream = new AssistantMessageEventStream();
    stream.push({ type: 'done', reason: 'stop', message: baseMessage(applied === 'priority' ? 20 : 10) });
    stream.end();
    return stream;
  };
  return { original, payloads };
}

async function run(speed: OpenAISpeed, applied?: string, date = new Date('2026-11-17T19:19:12Z')) {
  const reports: SpeedReport[] = [];
  const fake = fakeNative(applied);
  const wrapped = wrapOpenAISpeedStream(fake.original, () => selected(speed), r => reports.push(r), () => date);
  const result = await (await wrapped(model, context)).result();
  return { result, reports, payloads: fake.payloads };
}

describe('OpenAI requested-tier policy', () => {
  it('offers Standard by default and gates exact providers/models without inferring account access', () => {
    expect(getOpenAISpeedOptions(undefined, undefined)).toEqual(['standard']);
    expect(getOpenAISpeedOptions('pi/gpt-6.2-sol', 'openai-codex')).toEqual(['standard', 'fast', 'ultrafast']);
    expect(getOpenAISpeedOptions('pi/gpt-6.2-astra', 'openai-codex')).toEqual(['standard', 'fast']);
    expect(getOpenAISpeedOptions('pi/gpt-6.1-sol', 'openai-codex')).toEqual(['standard', 'fast']);
    expect(getOpenAISpeedOptions('pi/gpt-6.2-astra', 'openai')).toEqual(['standard', 'fast', 'ultrafast']);
    for (const provider of [undefined, 'custom-endpoint', 'anthropic']) {
      expect(() => assertOpenAISpeedAllowed('ultrafast', 'gpt-6.2-sol', provider)).toThrow();
    }
    expect(() => assertOpenAISpeedAllowed('ultrafast' as OpenAISpeed, 'gpt-6-luna', 'openai-codex')).toThrow();
    expect(() => assertOpenAISpeedAllowed('invalid' as OpenAISpeed, model.id, model.provider)).toThrow();
    for (const id of ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6.1-sol', 'gpt-6.1-terra']) {
      expect(getOpenAISpeedOptions(id, 'openai-codex')).toEqual(['standard', 'fast']);
    }
  });

  it('separates included allowance from credit/API estimates and honors Pacific promo cutoff', () => {
    expect(getOpenAISpeedMultipliers('ultrafast', model.id, 'openai-codex', new Date(ULTRAFAST_PROMO_END - 1)))
      .toMatchObject({ includedAllowance: 6, tokenCost: 3, basis: 'chatgpt' });
    expect(getOpenAISpeedMultipliers('ultrafast', model.id, 'openai-codex', new Date(ULTRAFAST_PROMO_END)))
      .toMatchObject({ includedAllowance: 6, tokenCost: 6 });
    expect(getOpenAISpeedMultipliers('fast', 'gpt-6.1-terra', 'openai-codex'))
      .toMatchObject({ includedAllowance: 2.5, tokenCost: 2 });
    expect(getOpenAISpeedMultipliers('ultrafast', model.id, 'openai')).toMatchObject({ includedAllowance: null, basis: 'api' });
    expect(getOpenAISpeedWarning('ultrafast', model.id, 'openai-codex')).toContain('6×');
    expect(getOpenAISpeedWarning('ultrafast', model.id, 'openai-codex')).toContain('only the provider');
    expect(getOpenAISpeedWarning('ultrafast', model.id, 'openai')).toContain('NOT your ChatGPT subscription');
    expect(getOpenAISpeedWarning('ultrafast', 'gpt-6.1-sol', 'openai')).toContain('US and EU');
  });
});

describe('native tier forwarding and truthful accounting (offline)', () => {
  it('sets explicit Standard/default and never advertises an unverified premium tier', async () => {
    const r = await run('standard', 'default');
    expect(r.payloads[0]).toEqual({ model: model.id, preserve: 'existing hook', service_tier: 'default' });
    expect(r.result.usage.cost.total).toBe(10);
    expect(r.reports).toEqual([]);
  });
  it('confirms only terminal provider metadata, scales Ultrafast token estimates3x not allowance6x', async () => {
    const r = await run('ultrafast', 'ultrafast');
    expect(r.payloads[0].service_tier).toBe('ultrafast');
    expect(r.reports[0]).toMatchObject({ verification: 'confirmed', applied: 'ultrafast', includedAllowanceMultiplier: 6,
      tokenCostEstimateMultiplier: 3 });
    expect(r.result.usage.cost.total).toBe(30);
    expect(r.reports[0]?.message).toContain('not actual ChatGPT charges');
    expect((await run('ultrafast', 'ultrafast', new Date(ULTRAFAST_PROMO_END))).result.usage.cost.total).toBe(60);
  });
  it('does not double-scale Fast costs already scaled by SDK priority accounting', async () => {
    const r = await run('fast', 'priority');
    expect(r.result.usage.cost.total).toBe(20);
    expect(r.payloads[0].service_tier).toBe('priority');
    expect(r.reports[0]?.verification).toBe('confirmed');
  });
  it('leaves tier application unverified when response omits service_tier, never infers from requested payload', async () => {
    const r = await run('ultrafast');
    expect(r.reports[0]).toMatchObject({ verification: 'unverified', applied: null });
    expect(r.reports[0]?.message).toContain('actual billing remain unverified');
  });
  it('fails visibly on provider tier mismatch instead of silently accepting a downgrade or unexpected premium', async () => {
    for (const [speed, applied] of [['ultrafast', 'default'], ['standard', 'ultrafast']] as const) {
      const r = await run(speed, applied);
      expect(r.result.stopReason).toBe('error');
      expect(r.result.errorMessage).toContain('no automatic fallback/retry');
      expect(r.reports[0]?.verification).toBe('mismatch');
    }
  });
  it('rejects changed model/provider/payload before sending and preserves existing onPayload callback', async () => {
    const fake = fakeNative();
    const wrapped = wrapOpenAISpeedStream(fake.original, () => ({ ...selected('ultrafast'), model: 'gpt-6.1-sol' }), () => {});
    await expect(wrapped(model, context)).rejects.toThrow('exact selected');
    expect(fake.payloads).toEqual([]);
    const bad = fakeNative(undefined, 'gpt-6.1-sol');
    await expect(wrapOpenAISpeedStream(bad.original, () => selected('ultrafast'), () => {})(model, context))
      .rejects.toThrow('changed the selected model');
    let called = 0;
    const good = fakeNative('ultrafast');
    await (await wrapOpenAISpeedStream(good.original, () => selected('ultrafast'), () => {})(model, context, {
      onPayload: payload => { called++; return { ...(payload as object), previousHook: true }; },
    })).result();
    expect(called).toBe(1);
    expect(good.payloads[0].previousHook).toBe(true);
  });
  it('really forwards tier through installed SDK streamSimple via final onPayload without network', async () => {
    let payload: any; let calls = 0;
    const fixture = `test.${btoa(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'offline-test' } }))}.test`;
    const original: StreamFn = (m, ctx, options) => codexSimple(m, ctx, { ...options, apiKey: fixture,
      onPayload: async (body, rm) => { payload = await options?.onPayload?.(body, rm); throw new Error('OFFLINE STOP'); },
      fetch: () => { calls++; throw new Error('NETWORK FORBIDDEN'); },
    });
    const result = await (await wrapOpenAISpeedStream(original, () => selected('ultrafast'), () => {})(model, context)).result();
    expect(payload.service_tier).toBe('ultrafast');
    expect(payload.model).toBe(model.id);
    expect(result.errorMessage).toContain('OFFLINE STOP');
    expect(calls).toBe(0);
  });
  it('disables implicit retries/cache warming for premium, restores existing Standard policy', () => {
    const calls: unknown[] = [];
    const session = { setCacheWarmingMode: (v: unknown) => calls.push(v), setAutoRetryEnabled: (v: unknown) => calls.push(v), setAutoCompactionEnabled: (v: unknown) => calls.push(v) };
    configureOpenAISpeedBudget(session, 'ultrafast');
    configureOpenAISpeedBudget(session, 'standard');
    expect(calls).toEqual(['off', false, false, 'streaming', true, true]);
  });
  it('pins utility/compaction routing IDs to explicit Standard instead of inheriting premium', async () => {
    const fake = fakeNative('default');
    const wrapped = wrapOpenAISpeedStream(fake.original, () => ({ ...selected('ultrafast'), sessionId: 'main-session' }), () => {});
    await (await wrapped(model, context, { sessionId: 'summary-routing-id' })).result();
    expect(fake.payloads[0].service_tier).toBe('default');
  });
  it('uses SSE with zero provider retries for premium, without changing Standard transport', async () => {
    const optionsSeen: any[] = [];
    const fake = fakeNative('ultrafast');
    const original: StreamFn = (m, ctx, options) => { optionsSeen.push(options); return fake.original(m, ctx, options); };
    await (await wrapOpenAISpeedStream(original, () => selected('ultrafast'), () => {})(model, context)).result();
    expect(optionsSeen[0]).toMatchObject({ transport: 'sse', maxRetries: 0 });
    const standard = fakeNative('default');
    const standardOptions: any[] = [];
    const originalStandard: StreamFn = (m, ctx, options) => { standardOptions.push(options); return standard.original(m, ctx, options); };
    await (await wrapOpenAISpeedStream(originalStandard, () => selected('standard'), () => {})(model, context, { transport: 'auto' })).result();
    expect(standardOptions[0].transport).toBe('auto');
  });
  it('real SDK compacts-and-continues Standard overflow but never repeats a premium call (zero network)', async () => {
    const loader = {
      getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
      getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => 'Offline premium test', getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {},
    } as unknown as ResourceLoader;
    const runtime = { hasConfiguredAuth: () => true, getModel: () => model, getAvailableSnapshot: () => [model],
      streamSimple: () => { throw new Error('NETWORK FORBIDDEN'); } } as unknown as ModelRuntime;
    for (const speed of ['standard', 'ultrafast'] as const) {
      const manager = SessionManager.inMemory();
      manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'Earlier offline context '.repeat(1500) }], timestamp: Date.now() });
      const prior = baseMessage(0); prior.content = [{ type: 'text', text: 'Prior offline response '.repeat(1500) }];
      manager.appendMessage(prior);
      const { session } = await createAgentSession({ cwd: '/tmp', agentDir: '/tmp', modelRuntime: runtime,
        model, sessionManager: manager, resourceLoader: loader, tools: [],
        settingsManager: SettingsManager.inMemory({ retry: { enabled: false, maxRetries: 0 }, compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 10 }, cacheWarming: 'off' }) });
      try {
        configureOpenAISpeedBudget(session, speed);
        // Isolate SDK overflow recovery from ordinary retries/warming in the Standard positive control.
        session.setAutoRetryEnabled(false); session.setCacheWarmingMode('off');
        let calls = 0; let mainCalls = 0; let summaries = 0; const bodies: any[] = [];
        const original: StreamFn = async (m, _ctx, options) => {
          calls++; bodies.push(await options?.onPayload?.({ model: m.id }, m));
          const main = options?.sessionId === session.sessionId;
          if (main) mainCalls++; else summaries++;
          if (speed !== 'standard' && main) expect(options).toMatchObject({ transport: 'sse', maxRetries: 0 });
          const stream = new AssistantMessageEventStream();
          const message = baseMessage(0);
          if (main && mainCalls === 1) {
            message.stopReason = 'error'; message.content = []; message.errorMessage = 'maximum context length exceeded';
            stream.push({ type: 'error', reason: 'error', error: message });
          } else { message.content = [{ type: 'text', text: 'Offline summary/recovered response' }]; stream.push({ type: 'done', reason: 'stop', message }); }
          stream.end(); return stream;
        };
        session.agent.streamFunction = wrapOpenAISpeedStream(original,
          () => ({ ...selected(speed), sessionId: session.sessionId }), () => {});
        await session.prompt('Offline overflow fixture');
        if (speed === 'ultrafast') {
          expect(calls).toBe(1); expect(mainCalls).toBe(1); expect(summaries).toBe(0);
          expect(bodies[0].service_tier).toBe('ultrafast');
          expect(session.autoCompactionEnabled).toBe(false);
        } else {
          // SDK can split summary generation into multiple partitions.
          expect(summaries).toBeGreaterThan(0); expect(mainCalls).toBe(2); expect(calls).toBe(summaries + 2);
          expect(bodies.every(b => b.service_tier === 'default')).toBe(true);
        }
      } finally { session.dispose(); }
    }

  });

  it('actual Codex SDK injected failures never duplicate premium calls or enter WS retry/fallback (zero network)', async () => {
    const previous = globalThis.WebSocket;
    let wsAttempts = 0;
    // Intercept even a regression that accidentally re-enters the WS auto path.
    globalThis.WebSocket = class { constructor() { wsAttempts++; throw new Error('OFFLINE WEBSOCKET BLOCKED'); } } as any;
    try {
      for (const [status, text] of [[503, 'offline service unavailable'], [403, 'ultrafast not entitled'],
        [400, 'previous_response_not_found'], [400, 'connection limit reached']] as const) {
        const id = `offline-premium-${status}-${text}`;
        resetOpenAICodexWebSocketDebugStats(id);
        let fetchCalls = 0; let payload: any;
        const fixture = `test.${btoa(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'offline-test' } }))}.test`;
        const original: StreamFn = (m, ctx, options) => codexSimple(m, ctx, { ...options, apiKey: fixture, env: {},
          onPayload: async (body, rm) => { payload = await options?.onPayload?.(body, rm); return payload; },
          fetch: async () => { fetchCalls++; return new Response(JSON.stringify({ error: { message: text } }), { status, headers: { 'content-type': 'application/json' } }); },
        });
        const result = await (await wrapOpenAISpeedStream(original, () => selected('ultrafast'), () => {})(model, context,
          { sessionId: id, transport: 'auto', maxRetries: 4 })).result();
        expect(result.stopReason).toBe('error');
        expect(fetchCalls).toBe(1);
        expect(payload).toMatchObject({ model: model.id, service_tier: 'ultrafast' });
        const stats = getOpenAICodexWebSocketDebugStats(id);
        expect(stats?.connectionsCreated ?? 0).toBe(0);
        expect(stats?.sseFallbacks ?? 0).toBe(0);
      }
      expect(wsAttempts).toBe(0);
    } finally { globalThis.WebSocket = previous; }
  });

  it('does not inject native Standard fields into a compatible/custom endpoint', async () => {
    const fake = fakeNative('default');
    await (await wrapOpenAISpeedStream(fake.original,
      () => ({ speed: 'standard', model: model.id, provider: undefined }), () => {})(model, context, { onPayload: body => body })).result();
    expect(fake.payloads[0].service_tier).toBeUndefined();
  });

  it('retains captured actual mismatch consumption and Standard estimate through error completion (offline)', async () => {
    const { events, result, reports, requests, baseCostEstimate } = await capturedSpeedEvents();
    expect(requests).toBe(1);
    expect(result.stopReason).toBe('error');
    expect(events.some(e => e.type === 'text_complete')).toBe(false);
    expect(events.find(e => e.type === 'complete')).toMatchObject({ usage: { inputTokens: 6714, outputTokens: 14, costUsd: baseCostEstimate } });
    expect(baseCostEstimate).toBeCloseTo(0.013568, 9);
    expect(reports[0]).toMatchObject({ requested: 'ultrafast', applied: 'default', verification: 'mismatch', tokenCostEstimateMultiplier: 1 });
  });
  it('preserves confirmed-success accounting with a clearly synthetic Ultrafast variant (offline)', async () => {
    const { events, reports, requests, baseCostEstimate } = await capturedSpeedEvents('ultrafast');
    expect(requests).toBe(1);
    expect(events.some(e => e.type === 'text_complete')).toBe(true);
    expect(events.find(e => e.type === 'complete')).toMatchObject({ usage: { inputTokens: 6714, outputTokens: 14, costUsd: baseCostEstimate * 3 } });
    expect(reports[0]).toMatchObject({ requested: 'ultrafast', applied: 'ultrafast', verification: 'confirmed', tokenCostEstimateMultiplier: 3 });
  });

});
