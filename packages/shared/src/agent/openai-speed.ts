/** Explicit per-session OpenAI speed preference. Never infer plan entitlement from a connection name. */
export type OpenAISpeed = 'standard' | 'fast' | 'ultrafast';
const FAST_MODELS = new Set(['gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6.1-sol', 'gpt-6.1-terra',
  'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna']);
const API_ULTRAFAST = new Set(['gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6-astra', 'gpt-6.1-sol']);
export const ULTRAFAST_PROMO_END = Date.UTC(2027, 2, 1, 8); // March1 midnight Pacific (PST)

export function isOpenAISpeed(value: unknown): value is OpenAISpeed {
  return value === 'standard' || value === 'fast' || value === 'ultrafast';
}
export function getOpenAISpeedOptions(model: string | undefined, provider: string | undefined): OpenAISpeed[] {
  const id = model?.replace(/^pi\//, '');
  const result: OpenAISpeed[] = ['standard'];
  if (!id || (provider !== 'openai' && provider !== 'openai-codex')) return result;
  if (FAST_MODELS.has(id)) result.push('fast');
  // OAuth exposes the documented Pro$200 subset only, NOT a claim this account has access.
  if (provider === 'openai-codex' ? id === 'gpt-6.2-sol' : API_ULTRAFAST.has(id)) result.push('ultrafast');
  return result;
}
export function assertOpenAISpeedAllowed(speed: OpenAISpeed, model: string | undefined, provider: string | undefined): void {
  if (!isOpenAISpeed(speed) || !getOpenAISpeedOptions(model, provider).includes(speed)) {
    throw new Error(`Requested OpenAI speed '${String(speed)}' is not supported for ${provider ?? 'unknown provider'}/${model ?? 'unknown model'}. Choose Standard explicitly or a supported model; no fallback was performed.`);
  }
}
export function getOpenAIServiceTier(speed: OpenAISpeed): 'default' | 'priority' | 'ultrafast' {
  return speed === 'ultrafast' ? 'ultrafast' : speed === 'fast' ? 'priority' : 'default';
}

/** Separate included allowance from token/credit estimates; never present a quota multiplier as dollars. */
export function getOpenAISpeedMultipliers(speed: OpenAISpeed, model: string | undefined, provider: string | undefined,
  now: Date = new Date()): { includedAllowance: number | null; tokenCost: number; basis: 'api' | 'chatgpt'; estimateOnly: true } {
  const id = model?.replace(/^pi\//, '') ?? '';
  const is62 = id === 'gpt-6.2-sol' || id === 'gpt-6.2-astra';
  const tokenCost = speed === 'standard' ? 1 : speed === 'fast' ? 2
    : is62 && now.getTime() < ULTRAFAST_PROMO_END ? 3 : 6;
  return {
    includedAllowance: provider !== 'openai-codex' ? null : speed === 'standard' ? 1
      : speed === 'fast' ? is62 ? 2 : 2.5 : is62 ? 6 : 8,
    tokenCost, basis: provider === 'openai-codex' ? 'chatgpt' : 'api', estimateOnly: true,
  };
}

export function getOpenAISpeedWarning(speed: OpenAISpeed, model: string | undefined, provider: string | undefined,
  now: Date = new Date()): string {
  if (speed === 'standard') return 'Standard speed. No premium speed-tier multiplier requested.';
  const m = getOpenAISpeedMultipliers(speed, model, provider, now);
  const tier = speed === 'ultrafast' ? 'Ultrafast' : 'Fast';
  const billing = provider === 'openai-codex'
    ? `${tier} uses ${m.includedAllowance}× your included ChatGPT allowance. Eligible purchased credits cost ${m.tokenCost}× Standard${speed === 'ultrafast' && m.tokenCost === 3 ? ' through February 28, 2027; then 6× from March 1 (Pacific time)' : ''}. Your account must be eligible; only the provider can confirm access.`
    : `${tier} requests use your existing API-key connection and separate API billing, NOT your ChatGPT subscription. Token rates are ${m.tokenCost}× Standard${speed === 'ultrafast' && m.tokenCost === 3 ? ' through February 28, 2027; then 6× from March 1 (Pacific time)' : ''}; cache and long-context charges also apply.`;
  const id = model?.replace(/^pi\//, '');
  const residency = speed !== 'ultrafast' ? '' : id === 'gpt-6.1-sol'
    ? ' GPT-6.1 Sol Ultrafast supports US and EU residency.'
    : ' Ultrafast processing for this model supports US residency only.';
  const performance = speed === 'ultrafast' && (id === 'gpt-6.2-sol' || id === 'gpt-6.2-astra')
    ? ' Up to 4.5× token generation is not a guaranteed task-speed gain.' : '';
  return `${billing}${residency}${performance} This is a requested tier, not verified availability or application. No automatic tier, model, or billing fallback.`;
}
