/** Synthetic local-only fixture: actual shared composer, no service, credentials or provider calls. */
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { TooltipProvider } from '@craft-agent/ui'
import { createStore } from 'jotai'
import { groupMessagesByTurn } from '@craft-agent/ui/chat/turn-utils'
import { FreeFormInput } from '../../components/app-shell/input/FreeFormInput'
import { MessageBubble } from '../../components/app-shell/chat-display/MessageBubble'
import { initializeSessionsAtom, sessionAtomFamily, sessionMetaMapAtom } from '../../atoms/sessions'
import { AppShellProvider, type AppShellContextType } from '../../context/AppShellContext'
import { EscapeInterruptProvider } from '../../context/EscapeInterruptContext'
import { ModalProvider } from '../../context/ModalContext'
import { ThemeProvider, useTheme } from '../../context/ThemeContext'
import { requestSessionOpenAISpeed } from '../../lib/openai-speed-command'
import { processEvent } from '../../event-processor/processor'
import type { AgentEvent, SessionState } from '../../event-processor/types'
import { makeSpeedMismatchEvents } from './openai-speed-accounting'
import { getOpenAISpeedWarning, type OpenAISpeed } from '@craft-agent/shared/agent/openai-speed'
import type { Session, SessionCommand } from '../../../shared/types'
import en from '../../../../../../packages/shared/src/i18n/locales/en.json'
import '../../index.css'

void i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en } }, keySeparator: false, interpolation: { escapeValue: false } })

window.electronAPI = {
  getAutoCapitalisation: async () => true,
  getSendMessageKey: async () => 'enter',
  getSpellCheck: async () => false,
  getTransportConnectionState: async () => ({ status: 'connected' }),
  onTransportConnectionStateChanged: () => () => {},
  getPendingPlanExecution: async () => null,
  getAvailablePermissionModes: async () => ['safe', 'ask', 'allow-all'],
  getRecentWorkingDirectories: async () => [],
  onDecisionConfigChanged: () => () => {},
} as unknown as typeof window.electronAPI

const fixture: any = { calls: [], mode: 'success', held: [], modelChanges: [], providerChanges: [], submissions: [] }
;(window as any).__speedFixture = fixture
const initial: Session = {
  id: 'synthetic-one', workspaceId: 'synthetic', workspaceName: 'Synthetic',
  messages: [], lastMessageAt: 0, isProcessing: false, model: 'pi/gpt-6.2-sol', llmConnection: 'synthetic-openai',
}
const noop = () => {}

function App() {
  const { setMode } = useTheme()
  fixture.theme = setMode
  const [session, setSession] = useState(initial)
  const [compact, setCompact] = useState(false)
  const [provider, setProvider] = useState<string | undefined>('openai-codex')
  const [providerType, setProviderType] = useState('pi')
  const [connectionUnavailable, setConnectionUnavailable] = useState(false)
  const [accountingPhase, setAccountingPhase] = useState<'live' | 'reloaded' | null>(null)
  fixture.applyEvents = (events: AgentEvent[]) => {
    setAccountingPhase('live')
    setSession(current => events.reduce<SessionState>(
      (state, event) => processEvent(state, event).state,
      { session: current, streaming: null },
    ).session)
  }
  fixture.speedMismatchEvents = () => makeSpeedMismatchEvents(session.id)
  fixture.saveSnapshot = () => JSON.stringify(session)
  fixture.reloadSnapshot = (snapshot: string) => {
    const saved = JSON.parse(snapshot) as Session
    const store = createStore()
    store.set(initializeSessionsAtom, [saved])
    fixture.reloadedMetadata = store.get(sessionMetaMapAtom).get(saved.id)
    setSession(store.get(sessionAtomFamily(saved.id))!)
    setAccountingPhase('reloaded')
  }
  fixture.turnTypes = groupMessagesByTurn(session.messages).map(turn => turn.type)
  fixture.configure = (options: any) => {
    setSession(current => ({ ...current, ...options.session }))
    if ('compact' in options) setCompact(options.compact)
    if ('provider' in options) setProvider(options.provider)
    if ('providerType' in options) setProviderType(options.providerType)
    if ('connectionUnavailable' in options) setConnectionUnavailable(options.connectionUnavailable)
  }
  fixture.newConversation = () => {
    setAccountingPhase(null)
    setSession({ ...initial, id: 'synthetic-two' })
  }
  fixture.release = () => fixture.held.splice(0).forEach((resolve: () => void) => resolve())
  fixture.warning = (speed: OpenAISpeed) => getOpenAISpeedWarning(speed, session.model, provider)
  fixture.session = session
  const command = async (id: string, command: SessionCommand) => {
    fixture.calls.push([id, command])
    if (fixture.mode === 'hold') await new Promise<void>(resolve => fixture.held.push(resolve))
    if (fixture.mode === 'reject') throw new Error('Synthetic disconnected transport')
    if (fixture.mode === 'error') return { success: false, error: 'Synthetic account eligibility failure' }
    if (command.type === 'setOpenAISpeed') {
      // Same canonical event as ChatPage receives; only saved state changes the requested label.
      setSession(current => processEvent({ session: current, streaming: null }, {
        type: 'session_metadata_changed', sessionId: id, changes: { openAISpeed: command.speed },
      }).state.session)
    }
    return { success: true }
  }
  const context = {
    activeWorkspaceId: 'synthetic', workspaces: [{ id: 'synthetic', slug: 'synthetic', rootPath: '/synthetic' }],
    workspaceDefaultLlmConnection: 'synthetic-openai',
    llmConnections: [{ slug: 'synthetic-openai', name: 'Synthetic Pro account name is not entitlement', providerType, piAuthProvider: provider,
      authType: 'api_key', isAuthenticated: true, isDefault: true,
      defaultModel: 'pi/gpt-6.2-sol', models: ['pi/gpt-6.2-sol', 'pi/gpt-6.1-sol', 'pi/gpt-6.1-terra'],
    }],
    sessionStatuses: [], labels: [], enabledSources: [], skills: [],
    sessionOptions: new Map(), onSessionOptionsChange: noop, pendingPermissions: new Map(), pendingCredentials: new Map(),
    isFocusedPanel: true, isCompactMode: compact, refreshLlmConnections: async () => {},
  } as unknown as AppShellContextType
  return (
    <TooltipProvider>
      <ModalProvider>
      <EscapeInterruptProvider>
        <AppShellProvider value={context}>
          <main className="@container/panel mx-auto flex min-h-screen w-full max-w-3xl flex-col justify-end bg-background p-3 text-foreground">
            <h1 className="mb-4 text-label">Synthetic {compact ? 'compact' : 'full'} composer — no provider calls</h1>
            {accountingPhase && (
              <section aria-label="Synthetic mismatch accounting" data-testid="mismatch-accounting" className="mb-4 space-y-3 text-label">
                <p>Offline error-accounting fixture, {accountingPhase}. NOT a successful Ultrafast response or actual billing proof.</p>
                <dl className="grid grid-cols-2 gap-1">
                  <dt>Consumed input tokens</dt><dd data-testid="consumed-input">{session.tokenUsage?.inputTokens ?? 0}</dd>
                  <dt>Consumed output tokens</dt><dd data-testid="consumed-output">{session.tokenUsage?.outputTokens ?? 0}</dd>
                  <dt>Total consumed tokens</dt><dd data-testid="consumed-total">{session.tokenUsage?.totalTokens ?? 0}</dd>
                  <dt>Native context occupancy (separate)</dt><dd data-testid="native-context-occupancy">{session.tokenUsage?.contextUsage?.usedTokens ?? 'unknown'}</dd>
                  <dt>Fixture Standard-rate estimate (USD)</dt><dd data-testid="standard-estimate">{session.tokenUsage?.costUsd.toFixed(6) ?? 'unknown'}</dd>
                </dl>
                <div data-testid="accounting-transcript">
                  {session.messages.map(message => (
                    <div key={message.id} data-message-role={message.role}>
                      <MessageBubble message={message} sessionId={session.id} compactMode={compact} onOpenFile={noop} onOpenUrl={noop} />
                    </div>
                  ))}
                </div>
              </section>
            )}
            <FreeFormInput
              currentModel={session.model!}
              currentConnection={session.llmConnection}
              sessionId={session.id}
              workspaceId="synthetic"
              isProcessing={session.isProcessing}
              isEmptySession={session.messages.length === 0}
              contextStatus={{
                inputTokens: session.tokenUsage?.inputTokens,
                contextWindow: session.tokenUsage?.contextWindow,
                contextUsage: session.tokenUsage?.contextUsage,
              }}
              compactMode={compact}
              enableCompactModelPicker
              connectionUnavailable={connectionUnavailable}
              openAISpeed={session.openAISpeed}
              onOpenAISpeedChange={(speed, acknowledged) => requestSessionOpenAISpeed(command, session.id, speed, acknowledged)}
              onModelChange={(...args) => fixture.modelChanges.push(args)}
              onConnectionChange={(...args) => fixture.providerChanges.push(args)}
              onSubmit={(...args) => fixture.submissions.push(args)}
              placeholder="Offline synthetic composer"
              onPermissionModeChange={noop}
              showPermissionModeChip
              onThinkingLevelChange={noop}
              sources={[]}
              skills={[]}
              labels={[]}
            />
          </main>
        </AppShellProvider>
      </EscapeInterruptProvider>
      </ModalProvider>
    </TooltipProvider>
  )
}

createRoot(document.getElementById('root')!).render(<ThemeProvider defaultMode="light"><App /></ThemeProvider>)
