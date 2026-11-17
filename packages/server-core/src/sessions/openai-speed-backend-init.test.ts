import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The platform registration is process-global. Capture init in a fresh process so this
// fixture cannot change any other test's platform, modules, env, or credential routing.
describe('OpenAI speed backend init', () => {
  it('passes the same-session requested tier to backend and resume config without provider calls', () => {
    const root = mkdtempSync(join(tmpdir(), 'speed-backend-init-'))
    const managerUrl = new URL('./SessionManager.ts', import.meta.url).href
    const sourceBuilderUrl = new URL('../sources/build-servers.ts', import.meta.url).href
    const backendUrl = new URL('../../../shared/src/agent/backend/index.ts', import.meta.url).href
    const script = `
      import { spyOn } from 'bun:test';
      import * as backend from ${JSON.stringify(backendUrl)};
      import * as sources from ${JSON.stringify(sourceBuilderUrl)};
      import { SessionManager, createManagedSession, setSessionPlatform } from ${JSON.stringify(managerUrl)};
      const logger = { debug() {}, info() {}, warn() {}, error() {} };
      setSessionPlatform({ appRootPath: process.cwd(), resourcesPath: process.cwd(), isPackaged: false, logger });
      const root = process.env.CRAFT_CONFIG_DIR;
      const workspace = { id: 'offline', name: 'Offline', rootPath: root, createdAt: 1 };
      spyOn(sources, 'buildServersFromSources').mockResolvedValue({ mcpServers: {}, apiServers: {} });
      spyOn(backend, 'resolveBackendContext').mockImplementation(args => ({
        connection: { slug: 'offline', providerType: 'pi', piAuthProvider: 'openai-codex', authType: 'oauth', defaultModel: 'pi/gpt-6.2-sol' },
        provider: 'pi', authType: 'oauth', resolvedModel: args.managedModel,
        capabilities: { needsHttpPoolServer: false },
      }));
      const captured = [];
      spyOn(backend, 'createBackendFromResolvedContext').mockImplementation(args => {
        captured.push({ speed: args.coreConfig.openAISpeed, resumeSpeed: args.coreConfig.session.openAISpeed });
        throw new Error('offline-init-captured'); // Stop before postInit/auth/subprocess work.
      });
      for (const speed of [undefined, 'standard', 'fast', 'ultrafast']) {
        const sm = new SessionManager();
        const managed = createManagedSession({ id: 'init', model: 'pi/gpt-6.2-sol', connectionLocked: true, openAISpeed: speed }, workspace, { messagesLoaded: true });
        try { await sm.getOrCreateAgent(managed); throw new Error('Expected capture'); }
        catch (error) { if (error.message !== 'offline-init-captured') throw error; }
      }
      console.log('SPEED_INIT_RESULT=' + JSON.stringify(captured));
    `
    try {
      const child = Bun.spawnSync([process.execPath, '-e', script], {
        cwd: new URL('../../../..', import.meta.url).pathname,
        env: { ...process.env, CRAFT_CONFIG_DIR: root },
        timeout: 15000,
      })
      expect(child.exitCode, child.stderr.toString()).toBe(0)
      const line = child.stdout.toString().split('\n').find(line => line.startsWith('SPEED_INIT_RESULT='))
      expect(line).toBeDefined()
      expect(JSON.parse(line!.slice('SPEED_INIT_RESULT='.length))).toEqual([
        {},
        { speed: 'standard', resumeSpeed: 'standard' },
        { speed: 'fast', resumeSpeed: 'fast' },
        { speed: 'ultrafast', resumeSpeed: 'ultrafast' },
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
