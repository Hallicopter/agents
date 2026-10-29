import { describe, it, expect } from 'bun:test';
import { handleSendAgentMessage } from './send-agent-message.ts';
import type { SessionToolContext, SendAgentMessageResult } from '../context.ts';

function createCtx(
  result: SendAgentMessageResult,
  opts?: { name?: string },
): { ctx: SessionToolContext; calls: Array<{ sessionId: string; message: string }> } {
  const calls: Array<{ sessionId: string; message: string }> = [];
  const ctx = {
    sessionId: 'sender-1',
    getSessionInfo: () => (opts?.name ? ({ name: opts.name } as never) : null),
    sendAgentMessage: async (sessionId: string, message: string) => {
      calls.push({ sessionId, message });
      return result;
    },
  } as unknown as SessionToolContext;
  return { ctx, calls };
}

describe('handleSendAgentMessage delivery ack', () => {
  it('reports a delivered ack when the target was idle', async () => {
    const { ctx } = createCtx({ delivery: 'delivered', targetBusy: false });
    const res = await handleSendAgentMessage(ctx, { sessionId: 'target-9', message: 'hi' });
    expect(res.isError).toBeFalsy();
    expect(JSON.stringify(res)).toContain('accepted');
    expect(JSON.stringify(res)).toContain('not completion');
  });

  it('reports a queued (busy) ack when the target was mid-turn', async () => {
    const { ctx } = createCtx({ delivery: 'queued', targetBusy: true });
    const res = await handleSendAgentMessage(ctx, { sessionId: 'target-9', message: 'status?' });
    expect(res.isError).toBeFalsy();
    const text = JSON.stringify(res);
    expect(text).toContain('queued');
    // Must warn the sender not to assume the message was read yet.
    expect(text.toLowerCase()).toContain('do not assume it was read');
  });

  it('reports a busy steer as active-turn acceptance, not a new independent turn', async () => {
    const { ctx } = createCtx({ delivery: 'delivered', targetBusy: true });
    const res = await handleSendAgentMessage(ctx, { sessionId: 'target-9', message: 'correction' });
    expect(JSON.stringify(res)).toContain('into its active turn');
    expect(JSON.stringify(res)).not.toContain('start processing independently');
  });

  it('surfaces an acceptance failure instead of reporting success', async () => {
    const { ctx } = createCtx({ delivery: 'delivered', targetBusy: false });
    ctx.sendAgentMessage = async () => { throw new Error('persistence failed'); };
    const res = await handleSendAgentMessage(ctx, { sessionId: 'target-9', message: 'hi' });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res)).toContain('persistence failed');
  });

  it('wraps the message with a sender envelope', async () => {
    const { ctx, calls } = createCtx({ delivery: 'delivered', targetBusy: false }, { name: 'Monitor' });
    await handleSendAgentMessage(ctx, { sessionId: 'target-9', message: 'ping' });
    expect(calls).toHaveLength(1);
    expect(calls[0].message).toContain('sender-1');
    expect(calls[0].message).toContain('ping');
  });

  it('rejects a self-send', async () => {
    const { ctx } = createCtx({ delivery: 'delivered', targetBusy: false });
    const res = await handleSendAgentMessage(ctx, { sessionId: 'sender-1', message: 'loop' });
    expect(res.isError).toBe(true);
  });
});
