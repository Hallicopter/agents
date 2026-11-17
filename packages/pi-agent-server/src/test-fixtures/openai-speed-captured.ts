/** OFFLINE ONLY: real sanitized mismatch metadata; other tiers are explicit synthetic variants. */
import { normalizeContext, type AssistantMessage } from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { getOpenAI62Models } from '../../../shared/src/config/openai-62-models';
import { PiEventAdapter } from '../../../shared/src/agent/backend/pi/event-adapter';
import { wrapOpenAISpeedStream, type SpeedReport } from '../openai-speed';
import fixture from './openai-ultrafast-provider-default.json';

export async function capturedSpeedEvents(applied: 'default' | 'ultrafast' = 'default') {
  const model = getOpenAI62Models('openai-codex').find(m => m.id === fixture.response.model)!;
  const raw = fixture.response.usage;
  const input = raw.input_tokens * model.cost.input / 1_000_000;
  const output = raw.output_tokens * model.cost.output / 1_000_000;
  const message: AssistantMessage = { role: 'assistant', api: model.api, model: model.id, provider: model.provider,
    content: [{ type: 'text', text: 'OFFLINE_ACCOUNTING_VARIANT' }], stopReason: 'stop', timestamp: 0,
    usage: { input: raw.input_tokens, output: raw.output_tokens, cacheRead: 0, cacheWrite: 0, totalTokens: raw.total_tokens,
      cost: { input, output, cacheRead: 0, cacheWrite: 0, total: input + output } } };
  let requests = 0;
  const original: StreamFn = async (m, _context, options) => {
    requests++;
    const body = await options?.onPayload?.({ model: m.id }, m) as { service_tier?: string };
    if (body.service_tier !== 'ultrafast') throw new Error('Offline fixture expected explicit Ultrafast request');
    await options?.onProviderStreamEvent?.({ type: fixture.type, response: { ...fixture.response, service_tier: applied } }, m);
    const stream = new AssistantMessageEventStream();
    stream.push({ type: 'done', reason: 'stop', message }); stream.end(); return stream;
  };
  const reports: SpeedReport[] = [];
  const wrapped = wrapOpenAISpeedStream(original, () => ({ speed: 'ultrafast', model: model.id, provider: model.provider }), r => reports.push(r), () => new Date('2026-11-17T20:40:35Z'));
  const result = await (await wrapped(model, normalizeContext({ messages: [] }))).result();
  const adapter = new PiEventAdapter(); adapter.startTurn('offline-accounting');
  const events = [...adapter.adaptEvent({ type: 'message_end', message: result } as never),
    ...adapter.adaptEvent({ type: 'agent_end', messages: [result], willRetry: false } as never)];
  return { events, result, reports, requests, baseCostEstimate: input + output };
}
