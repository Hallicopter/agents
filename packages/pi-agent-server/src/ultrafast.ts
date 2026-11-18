import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { grantProof } from '../../shared/src/credentials/ultrafast-grant.ts';

const scope = new AsyncLocalStorage<string>();
export const withUltraPrompt = <T>(nonce: string, run: () => T) => scope.run(nonce, run);
const pending = new Map<string, (allowed: boolean) => void>();
export function finishUltraCheck(id: string, allowed: boolean) { pending.get(id)?.(allowed); }
export type UltraCheck = { type: 'ultra_dispatch'; id: string; nonce: string; proof: string };
export function installUltraCheck(send: (request: UltraCheck) => void) {
  // Interceptor is preloaded separately from the child bundle, so use a process-local bridge.
  Object.assign(globalThis, { craftCheckUltra: async (headers: Headers) => {
    const nonce = scope.getStore();
    const bearer = /^Bearer ([^\s]+)$/i.exec(headers.get('authorization') ?? '')?.[1];
    if (!nonce || !bearer) throw new Error('Reselect Ultrafast before sending');
    const id = randomUUID();
    const allowed = await new Promise<boolean>((resolve) => {
      const done = (ok: boolean) => { clearTimeout(timer); pending.delete(id); resolve(ok); };
      const timer = setTimeout(() => done(false), 5000);
      pending.set(id, done);
      try { send({ type: 'ultra_dispatch', id, nonce, proof: grantProof(nonce, bearer) }); } catch { done(false); }
    });
    if (!allowed) throw new Error('Codex grant changed; reselect Ultrafast');
  }});
}
