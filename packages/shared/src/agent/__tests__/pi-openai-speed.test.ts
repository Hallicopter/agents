import { describe, expect, it } from 'bun:test';
import { PiAgent } from '../pi-agent.ts';

// Prototype-only fixture: no constructor, subprocess, filesystem, credentials or network.
function fixture() {
  const agent = Object.create(PiAgent.prototype) as any;
  agent.config = { providerType: 'pi', openAISpeed: 'standard', runtime: { piAuthProvider: 'openai-codex' } };
  agent._model = 'pi/gpt-6.2-sol'; agent._isProcessing = false;
  agent.pendingRuntimeConfigUpdates = new Map(); agent.rpcIdCounter = 0;
  agent.openAISpeedUpdateUncertain = false; agent.openAISpeedTimeoutMs = 15;
  agent.subprocess = null;
  return agent;
}
async function collect(iterable: AsyncIterable<any>) { const result = []; for await (const value of iterable) result.push(value); return result; }

describe('PiAgent acknowledged OpenAI speed', () => {
  it('sets an idle unspawned runtime preference locally, without starting one', async () => {
    const a = fixture(); a.send = () => { throw new Error('Unexpected subprocess send'); };
    await a.setOpenAISpeed('ultrafast');
    expect(a.config.openAISpeed).toBe('ultrafast'); expect(a.subprocess).toBeNull();
  });
  it('persists preference only after acknowledged runtime success and clears pending correlation', async () => {
    const a = fixture(); a.subprocess = {};
    a.send = (msg: any) => {
      expect(a.config.openAISpeed).toBe('standard');
      expect(msg.type).toBe('set_openai_speed');
      a.handleRuntimeConfigUpdateResult({ id: msg.id, success: true, updated: true });
    };
    await a.setOpenAISpeed('ultrafast');
    expect(a.config.openAISpeed).toBe('ultrafast'); expect(a.pendingRuntimeConfigUpdates.size).toBe(0);
    expect(a.openAISpeedUpdateUncertain).toBe(false);
  });
  it('never persists rejection, blocks prompts after ambiguity and allows explicit successful Standard recovery', async () => {
    const a = fixture(); a.subprocess = {};
    a.send = (msg: any) => a.handleRuntimeConfigUpdateResult({ id: msg.id, success: false, errorMessage: 'Tier not available' });
    await expect(a.setOpenAISpeed('ultrafast')).rejects.toThrow('Tier not available');
    expect(a.config.openAISpeed).toBe('standard');
    expect(a.openAISpeedUpdateUncertain).toBe(true);
    const events = await collect(a.chatImpl('Do not send a request'));
    expect(events[0].message).toContain('no request was made');
    expect(events.at(-1).type).toBe('complete');
    a.send = (msg: any) => a.handleRuntimeConfigUpdateResult({ id: msg.id, success: true, updated: true });
    await a.setOpenAISpeed('standard');
    expect(a.openAISpeedUpdateUncertain).toBe(false);
  });
  it('cleans up a lost-ack timeout and ignores late success without silently opting in', async () => {
    const a = fixture(); a.subprocess = {}; let id = '';
    a.send = (msg: any) => { id = msg.id; };
    await expect(a.setOpenAISpeed('ultrafast')).rejects.toThrow('timed out');
    expect(a.config.openAISpeed).toBe('standard');
    expect(a.pendingRuntimeConfigUpdates.size).toBe(0);
    expect(a.openAISpeedUpdateUncertain).toBe(true);
    a.handleRuntimeConfigUpdateResult({ id, success: true });
    expect(a.config.openAISpeed).toBe('standard');
  });
  it('rejects unsupported/busy/custom endpoint selections without sending anything', async () => {
    const a = fixture(); let sends = 0; a.send = () => sends++;
    a._model = 'pi/gpt-6.2-astra';
    await expect(a.setOpenAISpeed('ultrafast')).rejects.toThrow('not supported');
    a._model = 'pi/gpt-6.2-sol'; a._isProcessing = true;
    await expect(a.setOpenAISpeed('fast')).rejects.toThrow('processing');
    a._isProcessing = false; a.config.runtime.baseUrl = 'https://example.invalid';
    await expect(a.setOpenAISpeed('ultrafast')).rejects.toThrow('not supported');
    expect(sends).toBe(0);
  });
  it('rejects invalid premium endpoint config before spawning or looking up credentials', async () => {
    const a = fixture(); a.config.openAISpeed = 'ultrafast';
    a.config.runtime.baseUrl = 'https://example.invalid';
    await expect(a.spawnSubprocess()).rejects.toThrow('not supported');
    expect(a.subprocess).toBeNull();
  });
  it('rejects the ready handshake on init policy error instead of leaving a hanging turn', async () => {
    const a = fixture(); const events: any[] = [];
    a.debug = () => {}; a.resetSubprocessErrorDedup = () => {}; a.rejectAllPendingEphemeral = () => {};
    a.pendingEnsureSessionReady = new Map(); a.pendingCompactions = new Map(); a.pendingAutoCompactionToggles = new Map();
    a.eventQueue = { enqueue: (event: any) => events.push(event) };
    const ready = new Promise<void>((_resolve, reject) => { a.subprocessReadyReject = reject; });
    void ready.catch(() => {});
    a.handleLine(JSON.stringify({ type: 'error', message: 'Invalid OpenAI speed' }));
    await expect(ready).rejects.toThrow('Invalid OpenAI speed');
    expect(a.subprocessReadyReject).toBeNull();
    expect(events.some(e => e.message?.includes('Invalid OpenAI speed'))).toBe(true);
  });

});
