import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAgentSession, SessionManager, SettingsManager,
  type AgentSession, type AgentSessionEvent, type ModelRuntime,
} from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { createPuckAutoCompactionFocus, PUCK_AUTO_COMPACTION_FOCUS } from './puck-auto-compaction-focus.ts';
import { createCraftResourceLoader, createSystemPromptOverride } from './system-prompt-override.ts';

type Stream = AgentSession['agent']['streamFunction'];
type StreamCall = {
  model: Parameters<Stream>[0];
  options: Parameters<Stream>[2];
  text: string;
};
const MODEL: Model<'openai-responses'> = {
  id: 'offline-compaction', name: 'Offline compaction', provider: 'openai', api: 'openai-responses',
  baseUrl: 'https://invalid.test', reasoning: true, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000, maxTokens: 4_096,
};
const FOCUS_SUFFIX = `\n\nAdditional focus: ${PUCK_AUTO_COMPACTION_FOCUS}`;
const OK = { text: 'normal reply' };
type Reply = { text?: string; tokens?: number; error?: string };

async function withHarness(run: (args: {
  session: AgentSession;
  focus: ReturnType<typeof createPuckAutoCompactionFocus>;
  replies: Reply[];
  calls: StreamCall[];
  events: AgentSessionEvent[];
}) => Promise<void>, wrap = true) {
  const dir = mkdtempSync(join(tmpdir(), 'puck-auto-compact-'));
  const focus = createPuckAutoCompactionFocus();
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 30 },
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 }, cacheWarming: 'off',
  }, { projectTrusted: false });
  const replies: Reply[] = [];
  const calls: StreamCall[] = [];
  const stream: Stream = (model, context, options) => {
    const text = context.messages.filter(m => m.role === 'user').map(m =>
      typeof m.content === 'string' ? m.content : m.content.filter(c => c.type === 'text').map(c => c.text).join(''))
      .join('\n');
    calls.push({ model, options, text });
    const reply = replies.shift();
    if (!reply) throw new Error(`Unexpected offline stream call #${calls.length}`);
    const stream = createAssistantMessageEventStream();
    const tokens = reply.tokens ?? 100;
    const message: AssistantMessage = {
      role: 'assistant', content: reply.text ? [{ type: 'text', text: reply.text }] : [],
      api: MODEL.api, provider: MODEL.provider, model: MODEL.id,
      timestamp: Date.now(), stopReason: reply.error ? 'error' : 'stop', errorMessage: reply.error,
      usage: { input: tokens, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: tokens + 1,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    stream.push({ type: 'start', partial: { ...message, content: [], stopReason: 'pending' } });
    if (reply.error) stream.push({ type: 'error', reason: 'error', error: message });
    else stream.push({ type: 'done', reason: 'stop', message });
    return stream;
  };
  let session: AgentSession | undefined;
  try {
    ({ session } = await createAgentSession({
      cwd: dir, agentDir: dir, settingsManager, model: MODEL, thinkingLevel: 'low', tools: [],
      sessionManager: SessionManager.inMemory(dir),
      resourceLoader: await createCraftResourceLoader({
        cwd: dir, agentDir: dir, settingsManager, systemPromptOverride: createSystemPromptOverride(),
        extraExtensions: wrap ? [focus.extension] : [],
      }),
      modelRuntime: {
        getModel: () => MODEL,
        getAvailableSnapshot: () => [MODEL],
        hasConfiguredAuth: () => true,
        getAuth: async () => ({ auth: { apiKey: 'offline-fixture' } }),
        streamSimple: stream, // Exercise the real SDK stream closure, but never reach the network.
      } as unknown as ModelRuntime,
    }));
    if (wrap) session.agent.streamFunction = focus.wrap(session.agent.streamFunction);
    const events: AgentSessionEvent[] = [];
    session.subscribe(event => events.push(event));
    await run({ session, focus, replies, calls, events });
    expect(replies).toHaveLength(0);
  } finally {
    session?.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function chat(session: AgentSession, text: string) {
  await session.prompt(text);
  await session.waitForIdle();
}

const firstTurn = 'Original scope and path /fixture/exact.md. '.repeat(12);
const longTurn = 'Continuation after the recorded scope. '.repeat(10);
const thresholdReply = { text: 'answered near the limit', tokens: 88_000 };

it('adds focus to native threshold summaries and subsequent previous-summary updates', async () => {
  await withHarness(async ({ session, focus, replies, calls, events }) => {
    focus.setEnabled(true);
    replies.push(OK, thresholdReply, { text: 'first checkpoint' }, thresholdReply, { text: 'updated checkpoint' });
    await chat(session, firstTurn);
    await chat(session, longTurn);
    // The real SDK ignores usage from timestamps at or before the checkpoint.
    // Fast in-memory streams need a distinct millisecond for the next response.
    await Bun.sleep(2);
    await chat(session, 'Newer decision for the checkpoint. '.repeat(10));
    expect(calls).toHaveLength(5); // Three normal turns + two native summary calls.
    expect(calls[2]!.text).toContain('Create a structured context checkpoint summary');
    expect(calls[2]!.text).toContain('/fixture/exact.md');
    expect(calls[2]!.text).toEndWith(FOCUS_SUFFIX);
    expect(calls[4]!.text).toContain('<previous-summary>\nfirst checkpoint');
    expect(calls[4]!.text).toContain('NEW conversation messages');
    expect(calls[4]!.text).toEndWith(FOCUS_SUFFIX);
    for (const i of [0, 1, 3]) expect(calls[i]!.text).not.toContain(FOCUS_SUFFIX);
    for (const i of [2, 4]) {
      expect(calls[i]!.model).toBe(MODEL);
      expect(calls[i]!.options).toMatchObject({ apiKey: 'offline-fixture', reasoning: 'low', maxTokens: 4_096, cacheRetention: 'none' });
    }
    expect(events.filter(e => e.type === 'compaction_end').map(e => [e.reason, !!e.result, e.willRetry]))
      .toEqual([['threshold', true, false], ['threshold', true, false]]);
    const entries = session.sessionManager.getEntries().filter(e => e.type === 'compaction');
    expect(entries.map(e => !!e.fromHook)).toEqual([false, false]);
    expect(entries[1]?.summary).toContain('updated checkpoint');
    expect(entries[1]?.details).toEqual({ readFiles: [], modifiedFiles: [] });
  });
});

it('focuses overflow and the native summary retry, not the SDK’s resumed turn', async () => {
  await withHarness(async ({ session, focus, replies, calls, events }) => {
    focus.setEnabled(true);
    replies.push(OK, { error: 'maximum context length exceeded' }, { error: 'socket hang up' },
      { text: 'overflow checkpoint' }, { text: 'retained turn prefix' }, OK);
    await chat(session, firstTurn);
    await chat(session, longTurn);
    expect(calls).toHaveLength(6);
    expect(calls[2]!.text).toEndWith(FOCUS_SUFFIX);
    expect(calls[3]!.text).toBe(calls[2]!.text);
    expect(calls[3]!.options?.signal).toBe(calls[2]!.options?.signal);
    expect(calls[4]!.text).toContain('earlier context from an ongoing conversation');
    expect(calls[4]!.text).toEndWith(FOCUS_SUFFIX);
    expect(calls[5]!.text).not.toContain(FOCUS_SUFFIX);
    expect(events.filter(e => e.type === 'compaction_end').map(e => [e.reason, !!e.result, e.willRetry]))
      .toEqual([['overflow', true, true]]);
    const [entry] = session.sessionManager.getEntries().filter(e => e.type === 'compaction');
    expect(entry?.summary).toContain('overflow checkpoint');
    expect(entry?.summary).toContain('retained turn prefix');
    expect(entry?.fromHook).toBeFalsy();
  });
});

it('leaves native threshold and manual prompt text identical off-scope and keeps explicit manual instructions in Puck', async () => {
  async function summaries(wrap: boolean) {
    const out: string[] = [];
    await withHarness(async ({ session, focus, replies, calls }) => {
      // Exercise an explicit role opt-out on the same instantiated SDK session.
      focus.setEnabled(true);
      focus.setEnabled(false);
      replies.push(OK, thresholdReply, { text: 'auto checkpoint' }, OK, OK, { text: 'manual checkpoint' });
      await chat(session, firstTurn);
      await chat(session, longTurn);
      focus.setEnabled(true);
      await chat(session, 'After threshold 1. '.repeat(12));
      await chat(session, 'After threshold 2. '.repeat(12));
      await session.compact('Keep my exact manual emphasis.');
      expect(calls).toHaveLength(6);
      out.push(calls[2]!.text, calls[5]!.text);
    }, wrap);
    return out;
  }
  const baseline = await summaries(false);
  const withFocus = await summaries(true);
  expect(withFocus).toEqual(baseline);
  expect(withFocus[0]).not.toContain('Additional focus:');
  expect(withFocus[1]).toEndWith('Additional focus: Keep my exact manual emphasis.');
});

it('does not enable automatic compaction when Pi has disabled it', async () => {
  await withHarness(async ({ session, focus, replies, calls, events }) => {
    focus.setEnabled(true);
    session.setAutoCompactionEnabled(false);
    replies.push(OK, thresholdReply);
    await chat(session, firstTurn);
    await chat(session, longTurn);
    expect(calls).toHaveLength(2);
    expect(events.some(e => e.type === 'compaction_start')).toBe(false);
  });
});
