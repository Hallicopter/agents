export { companionNodeHandler } from '../../server-core/src/companion/node-http'
import { join } from 'node:path'
import { staticPageHtml } from '../../server-core/src/companion/page-html'
import { CompanionStore } from '../../server-core/src/companion/store'
import { createCompanionHandler, type CompanionBackend } from '../../server-core/src/companion/http'
import { startCompanionAdmin } from '../../server-core/src/companion/admin'
import type { SessionManager } from '@craft-agent/server-core/sessions'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { loadWorkspacePages, loadPage, loadPageContent } from '@craft-agent/shared/pages'

export function companionBackend(sm: SessionManager): CompanionBackend {
  const workspace = (id: string) => { const w = getWorkspaceByNameOrId(id); if (!w || w.id !== id) throw new Error('Unknown workspace'); return w }
  const pageInfo = (config: { slug: string; name: string; description?: string }) => ({ slug: config.slug, name: config.name, description: config.description })
  return {
    sessions: id => sm.getSessions(id),
    session: id => sm.getSession(id),
    create: (id, name) => sm.createSession(id, { name, permissionMode: 'safe', enabledSourceSlugs: [], workingDirectory: 'none' }),
    send: (id, text, allowExistingPermissions, authorize) => new Promise<void>((resolve, reject) => {
      const guard = () => {
        authorize()
        const target = sm.getSessions().find(s => s.id === id)
        if (!target || (target.permissionMode !== 'safe' && !allowExistingPermissions)) throw new Error('Permission mode changed')
      }
      // Acknowledge only once the real SessionManager has persisted the user's message.
      sm.sendMessage(id, text, undefined, undefined, undefined, undefined, undefined, () => resolve(), undefined, guard)
        .then(() => resolve(), reject)
    }),
    pages: async id => loadWorkspacePages(workspace(id).rootPath).map(p => pageInfo(p.config)),
    page: async (id, slug) => {
      const root = workspace(id).rootPath
      const p = loadPage(root, slug)
      if (!p) return null
      // Never return HTML, scripts, data stores, grants, credentials or filesystem paths.
      const html = loadPageContent(root, slug) ?? ''
      const contentText = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
      return { page: pageInfo(p.config), contentText, contentHtml: await staticPageHtml(html) }
    },
  }
}

export async function initializeCompanion(sm: SessionManager, configDir: string) {
  const store = new CompanionStore(join(configDir, 'companion'))
  const admin = await startCompanionAdmin(store, id => getWorkspaceByNameOrId(id)?.id === id)
  return { handler: createCompanionHandler(store, companionBackend(sm)), admin }
}
