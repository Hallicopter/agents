import * as React from 'react'
import { ChevronDown } from 'lucide-react'
import {
  getOpenAISpeedOptions,
  getOpenAISpeedWarning,
  type OpenAISpeed,
} from '@craft-agent/shared/agent/openai-speed'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useRegisterModal } from '@/context/ModalContext'
import { COMPOSER_CHIP } from './composer-styles'

const LABELS: Record<OpenAISpeed, string> = {
  standard: 'Standard',
  fast: 'Fast',
  ultrafast: 'Ultrafast',
}
const SPEEDS: OpenAISpeed[] = ['standard', 'fast', 'ultrafast']

export interface OpenAISpeedProps {
  openAISpeed?: OpenAISpeed
  /** Resolves only after the session command succeeds; never switches a model or connection. */
  onOpenAISpeedChange?: (speed: OpenAISpeed, acknowledged?: true) => Promise<void>
}

interface OpenAISpeedSelectorProps extends OpenAISpeedProps {
  model: string
  /** The connection's piAuthProvider, not its name or display label. */
  provider?: string
  disabled?: boolean
}

/** Shared by the desktop and browser composers, in full and compact layouts.
 * Only the draft changes locally. The requested chip is always authoritative session state.
 */
export function OpenAISpeedSelector({
  model,
  provider,
  openAISpeed = 'standard',
  onOpenAISpeedChange,
  disabled = false,
}: OpenAISpeedSelectorProps) {
  const [open, setOpen] = React.useState(false)
  const [draft, setDraft] = React.useState(openAISpeed)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const cancelRef = React.useRef<HTMLButtonElement>(null)
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const inFlight = React.useRef(false)
  const mounted = React.useRef(true)
  const radioName = React.useId()
  const warningId = React.useId()
  useRegisterModal(open, () => { if (!inFlight.current) setOpen(false) })
  React.useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const options = getOpenAISpeedOptions(model, provider)
  // Keep a recovery path to Standard for a persisted premium request on an unsupported model.
  if (!onOpenAISpeedChange || (options.length <= 1 && openAISpeed === 'standard')) return null

  const allowed = options.includes(draft)
  const warning = draft !== 'standard' && allowed
    ? getOpenAISpeedWarning(draft, model, provider)
    : null
  const changeOpen = (next: boolean) => {
    if (inFlight.current) return
    if (next) {
      setDraft(openAISpeed)
      setError(null)
    }
    setOpen(next)
  }
  const confirm = async () => {
    // Standard must remain explicitly re-requestable after an uncertain backend acknowledgment,
    // even when the saved field already says Standard. Never clear that latch optimistically.
    if (inFlight.current || disabled || !allowed || (draft === openAISpeed && draft !== 'standard')) return
    inFlight.current = true
    setSaving(true)
    setError(null)
    try {
      await onOpenAISpeedChange(draft, draft === 'standard' ? undefined : true)
      if (mounted.current) setOpen(false)
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      inFlight.current = false
      if (mounted.current) setSaving(false)
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`${COMPOSER_CHIP} shrink-0 @max-[22rem]/panel:h-auto @max-[22rem]/panel:min-h-11`}
        aria-label={`OpenAI speed — Requested: ${LABELS[openAISpeed]}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        title="Requested speed only. Provider acceptance and account eligibility are not verified."
        onClick={() => changeOpen(true)}
      >
        <span className="@max-[22rem]/panel:w-20 @max-[22rem]/panel:whitespace-normal @max-[22rem]/panel:text-center @max-[22rem]/panel:leading-tight">Requested: {LABELS[openAISpeed]}</span>
        <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
      </button>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent
          showCloseButton={false}
          aria-busy={saving}
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
          onOpenAutoFocus={(event) => { event.preventDefault(); cancelRef.current?.focus() }}
          onCloseAutoFocus={(event) => { event.preventDefault(); triggerRef.current?.focus() }}
          onEscapeKeyDown={(event) => { if (inFlight.current) event.preventDefault() }}
          onPointerDownOutside={(event) => { if (inFlight.current) event.preventDefault() }}
        >
          <DialogHeader>
            <DialogTitle>OpenAI speed request</DialogTitle>
            <DialogDescription>
              This conversation only. Standard is the default for new conversations.
              Requested speed is not confirmation of provider acceptance or account eligibility.
            </DialogDescription>
          </DialogHeader>
          <fieldset disabled={saving || disabled} aria-describedby={warning ? warningId : undefined} className="min-w-0 space-y-1">
            <legend className="mb-2 text-label font-medium">Requested speed</legend>
            {SPEEDS.map((speed) => {
              const supported = options.includes(speed)
              return (
                <label key={speed} className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-label hover:bg-fill-hover ${!supported ? 'cursor-not-allowed text-disabled' : ''}`}>
                  <input
                    type="radio"
                    name={radioName}
                    value={speed}
                    checked={draft === speed}
                    disabled={!supported}
                    onChange={() => { setDraft(speed); setError(null) }}
                    className="size-4 shrink-0 accent-current"
                  />
                  <span>{LABELS[speed]}{!supported && ' — unavailable for this model/connection'}</span>
                </label>
              )
            })}
          </fieldset>
          <div aria-live="polite" aria-atomic="true">
            {warning && (
              <div id={warningId} role="note" aria-label="Speed allowance, cost and residency warning" className="whitespace-pre-wrap break-words rounded-md bg-info-tint p-3 text-label text-foreground">
                {warning}
              </div>
            )}
          </div>
          {!allowed && (
            <p className="text-label text-destructive">This request is unavailable for the current model/connection. Select Standard, or change the model/connection explicitly.</p>
          )}
          {disabled && <p role="status" className="text-label">Wait until this conversation is idle before changing speed.</p>}
          {error && <p role="alert" className="break-words text-label text-destructive">Speed request failed: {error}</p>}
          <DialogFooter>
            <Button ref={cancelRef} type="button" variant="ghost" disabled={saving} onClick={() => changeOpen(false)} className="min-h-11 px-4">Cancel</Button>
            <Button type="button" disabled={saving || disabled || !allowed || (draft === openAISpeed && draft !== 'standard')} onClick={() => { void confirm() }} className="min-h-11 px-4">
              {saving ? 'Requesting…' : draft === 'standard' ? 'Request Standard' : `Confirm ${LABELS[draft]} request`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
