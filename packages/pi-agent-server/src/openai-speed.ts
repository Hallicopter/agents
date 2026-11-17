import type { AssistantMessage } from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { assertOpenAISpeedAllowed, getOpenAIServiceTier, getOpenAISpeedMultipliers,
  type OpenAISpeed } from '../../shared/src/agent/openai-speed.ts';

const CODEX_BASE_URLS = new Set(['https://chatgpt.com/backend-api', 'https://chatgpt.com/backend-api/codex',
  'https://chatgpt.com/backend-api/codex/responses']);

export interface SpeedReport {
  requested: OpenAISpeed;
  applied: string | null;
  verification: 'confirmed' | 'unverified' | 'mismatch';
  includedAllowanceMultiplier: number | null;
  tokenCostEstimateMultiplier: number;
  message: string;
}

/** Keep the native authenticated stream, prompt hooks and response handling intact.
 * Inject after its payload hooks: Pi1.1 streamSimple drops serviceTier options, and
 * extension-handler errors are swallowed by the SDK, so neither is a safe guard.
 */
export function wrapOpenAISpeedStream(original: StreamFn,
  preference: () => { speed: OpenAISpeed; model?: string; provider?: string; sessionId?: string },
  report: (value: SpeedReport) => void,
  now: () => Date = () => new Date()): StreamFn {
  return async (model, context, options) => {
    const requested = preference();
    // SDK summaries/compactions use distinct routing IDs. They do not inherit
    // a main-chat premium preference, even when sharing the native stream.
    const selected = requested.sessionId && options?.sessionId !== requested.sessionId
      ? { ...requested, speed: 'standard' as const } : requested;
    assertOpenAISpeedAllowed(selected.speed, model.id, model.provider);
    const native = (model.provider === 'openai' || model.provider === 'openai-codex')
      && selected.provider === model.provider;
    if (!native && selected.speed === 'standard') return original(model, context, options);
    if (selected.speed !== 'standard' && (model.id !== selected.model?.replace(/^pi\//, '') ||
        model.provider !== selected.provider || model.api !== (model.provider === 'openai-codex' ? 'openai-codex-responses' : 'openai-responses'))) {
      throw new Error('Requested premium speed requires the exact selected native model/provider. No model, tier, or billing fallback was performed.');
    }
    const requestedTier = getOpenAIServiceTier(selected.speed);
    // The official Codex client sends this advisory routing header *as well as*
    // service_tier for native OAuth inference (openai/codex#37345). Never use
    // it as evidence of entitlement or of the model/tier actually served.
    const codexUltra = selected.speed === 'ultrafast' && model.provider === 'openai-codex';
    const hint = `model=${model.id};tier=${requestedTier}`;
    if (codexUltra) {
      if (!CODEX_BASE_URLS.has(model.baseUrl.replace(/\/+$/, ''))) {
        throw new Error('Ultrafast routing requires the native ChatGPT Codex endpoint. No request sent.');
      }
      for (const headers of [model.headers, options?.headers]) {
        for (const [name, value] of Object.entries(headers ?? {})) {
          if ((name.toLowerCase() === 'x-codex-routing-hint' && value !== hint) ||
              (name.toLowerCase() === 'x-codex-guardian' && value?.trim().toLowerCase() === 'reviewer')) {
            throw new Error('Explicit Ultrafast conflicts with existing Codex request routing. No request sent.');
          }
        }
      }
    }
    let applied: string | null = null;
    let terminalObserved = false;
    const underlying = await original(model, context, {
      ...options,
      ...(codexUltra ? { headers: { ...options?.headers, 'x-codex-routing-hint': hint } } : {}),
      // Premium requests are never automatically retried by the provider layer.
      ...(selected.speed !== 'standard' ? { maxRetries: 0, transport: 'sse' as const } : {}),
      onPayload: async (payload, requestModel) => {
        const transformed = await options?.onPayload?.(payload, requestModel);
        const body = transformed === undefined ? payload : transformed;
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid native OpenAI request payload');
        if ((body as { model?: unknown }).model !== model.id) throw new Error('OpenAI payload changed the selected model; request blocked before sending');
        // Explicit default prevents an account-level default from silently opting into premium.
        return { ...body, service_tier: requestedTier };
      },
      onProviderStreamEvent: async (data, responseModel) => {
        await options?.onProviderStreamEvent?.(data, responseModel);
        if (!data || typeof data !== 'object') return;
        const event = data as { type?: string; response?: { service_tier?: unknown } };
        // Only provider-returned terminal response metadata counts as evidence.
        // Never use requested options or SDK's echoed message.model as verification.
        if (event.type === 'response.completed' || event.type === 'response.failed' || event.type === 'response.incomplete') {
          terminalObserved = true;
          applied = typeof event.response?.service_tier === 'string' ? event.response.service_tier : null;
        }
      },
    });
    const output = new AssistantMessageEventStream();
    void (async () => {
      try {
        for await (const event of underlying) {
          if (event.type === 'done' || event.type === 'error') {
            const message = event.type === 'done' ? event.message : event.error;
            const verification = applied === requestedTier ? 'confirmed' : applied ? 'mismatch' : 'unverified';
            const m = getOpenAISpeedMultipliers(selected.speed, model.id, model.provider, now());
            // SDK already scales a provider-confirmed priority response2x, but
            // does not know Ultrafast. Correct *estimates*, not subscription bills.
            const sdkMultiplier = applied === 'priority' ? 2 : applied === 'flex' ? 0.5 : 1;
            const estimatedMultiplier = verification === 'mismatch' ? sdkMultiplier : m.tokenCost;
            scaleCostEstimate(message, estimatedMultiplier / sdkMultiplier);
            if (selected.speed !== 'standard' || verification === 'mismatch') {
              const detail = verification === 'confirmed'
                ? `Provider terminal reported the requested tier (${applied}).`
                : verification === 'mismatch'
                  ? `Provider returned ${applied}, not requested ${requestedTier}; no fallback or automatic retry was performed.`
                  : `Provider did not confirm the requested service tier${terminalObserved ? '' : ' (no terminal response metadata)'}. Availability, application and actual billing remain unverified.`;
              report({ requested: selected.speed, applied, verification,
                includedAllowanceMultiplier: m.includedAllowance,
                tokenCostEstimateMultiplier: estimatedMultiplier,
                message: `${detail} Displayed monetary costs are token-rate estimates, not actual ChatGPT charges. ${m.includedAllowance === null ? 'Separate API billing applies.' : `Requested tier uses ${m.includedAllowance}× included allowance; purchased-credit rates differ.`}` });
            }
            if (verification === 'mismatch') {
              message.stopReason = 'error';
              const uncertainty = model.provider === 'openai-codex' ? ' Actual execution tier is unverified.' : '';
              message.errorMessage = `OpenAI service tier mismatch: requested ${requestedTier}, received ${applied}.${uncertainty} Usage may have been consumed; no automatic fallback/retry.`;
              output.push({ type: 'error', reason: 'error', error: message });
              output.end();
              return;
            }
          }
          output.push(event);
        }
        output.end();
      } catch (error) {
        const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider,
          model: model.id, content: [], timestamp: Date.now(), stopReason: 'error', errorMessage: String(error),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        output.push({ type: 'error', reason: 'error', error: message }); output.end();
      }
    })();
    return output;
  };
}

function scaleCostEstimate(message: AssistantMessage, multiplier: number): void {
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const) {
    message.usage.cost[key] *= multiplier;
  }
}

/** No implicit paid cache warming or agent-level retries for premium requests. */
export function configureOpenAISpeedBudget(session: Pick<AgentSession, 'setCacheWarmingMode' | 'setAutoRetryEnabled' | 'setAutoCompactionEnabled'>,
  speed: OpenAISpeed): void {
  session.setCacheWarmingMode(speed === 'standard' ? 'streaming' : 'off');
  session.setAutoRetryEnabled(speed === 'standard');
  session.setAutoCompactionEnabled(speed === 'standard');
}
