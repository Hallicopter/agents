import { randomBytes } from 'node:crypto'

export interface HumanInputScope {
  readonly workspaceId: string
  readonly sessionId: string
  readonly connectionId: string
}

/** Private, durable record for ONE desktop. Missing/unreadable records must not become clean. */
export interface InputArbiterJournal {
  readonly version: 1
  readonly dirty: boolean
}

declare const agentBrand: unique symbol
declare const humanBrand: unique symbol
/** In-process capabilities: retain server-side, never deserialize from a client or another arbiter. */
export interface AgentReservation { readonly generation: string; readonly [agentBrand]: true }
export interface HumanLease { readonly generation: string; readonly [humanBrand]: true }
export type InputArbiterPhase = 'idle' | 'agent' | 'human' | 'releasing' | 'quarantine'
export interface InputArbiterState {
  readonly phase: InputArbiterPhase
  readonly humanExpiresAt: number | null
}

export interface InputArbiterOptions {
  readonly initialJournal: InputArbiterJournal
  /** Synchronous atomic durable replace + fsync, BEFORE returning. Throw on any uncertainty. */
  readonly persistJournal: (record: InputArbiterJournal) => void
  /** Human takeover denies ANY cooperative owner. Agents retain existing owner-token checks. */
  readonly cooperativeOwnerPresent: () => boolean
  readonly legacyProxyActive: () => boolean
  /** Must check current authenticated connection, membership, revocation AND desktop entitlement. */
  readonly authorizeHuman: (scope: HumanInputScope) => boolean
  readonly now?: () => number
  /** Per explicit acquisition/renewal, at most five minutes. */
  readonly maxLeaseMs?: number
  /** Absolute uninterrupted human ownership limit, at most five minutes. */
  readonly maxContinuousMs?: number
}

export class InputArbiterError extends Error {
  constructor(readonly code: 'denied' | 'invalid' | 'quarantined') {
    super(`Desktop input ${code}`)
    this.name = 'InputArbiterError'
  }
}

/**
 * One instance per desktop, on one JS event loop, shared by EVERY mutator.
 * This is not a distributed lock or a legacy-proxy interposition mechanism.
 * The host must establish exclusive broker coverage and truthful synchronous
 * owner/legacy checks BEFORE permitting human admission. Unknown coverage must
 * report legacyProxyActive=true. There are no default permissive callbacks.
 *
 * This arbiter excludes humans vs all agent mutators; it does NOT authenticate
 * an agent's cooperative owner token. The trusted proxy MUST retain existing
 * agent-v-agent owner authorization. An existing cooperative owner denies human
 * takeover, not that owner's brokered agent call; no owner is cleared/stolen.
 * Agent reservations cover actual upstream completion, NOT dispatch/queueing.
 * Timeout, disconnect, proxy crash or uncertain completion => definitive=false.
 * Human writes must execute synchronously inside writeHuman, never queue a
 * callback for later execution. Upstream failure after an accepted write must
 * call quarantine(). A socket.write success alone is NOT release confirmation:
 * finishRelease(true) asserts all queued writes drained/ordered, held keys and
 * buttons neutralized and the old input path fenced at the upstream boundary.
 *
 * Expiry is lazy at every public boundary (no timer can clear ownership).
 * Expiry/revoke/authorization loss fence writes but retain dirty ownership until
 * confirmed cleanup. Quarantine has no reset API. Restart only after external
 * reconciliation durably establishes clean state; never rewrite dirty on boot.
 * Callbacks are trusted synchronous adapters; promises and reentry are rejected.
 */
export class InputArbiter {
  readonly #options: InputArbiterOptions
  readonly #maxLeaseMs: number
  readonly #maxContinuousMs: number
  #phase: InputArbiterPhase
  #agent: AgentReservation | null = null
  #human: { lease: HumanLease; scope: HumanInputScope; expiresAt: number; limit: number } | null = null
  #entered = false
  #reentered = false
  #lastNow = -Infinity
  #dirty: boolean

  constructor(options: InputArbiterOptions) {
    if (!options || options.initialJournal?.version !== 1 || typeof options.initialJournal.dirty !== 'boolean'
      || !['persistJournal', 'cooperativeOwnerPresent', 'legacyProxyActive', 'authorizeHuman'].every(key => typeof (options as unknown as Record<string, unknown>)[key] === 'function')
      || (options.now !== undefined && typeof options.now !== 'function')) throw new InputArbiterError('invalid')
    this.#maxLeaseMs = options.maxLeaseMs ?? 300_000
    this.#maxContinuousMs = options.maxContinuousMs ?? 300_000
    if (!Number.isSafeInteger(this.#maxLeaseMs) || this.#maxLeaseMs <= 0 || this.#maxLeaseMs > 300_000
      || !Number.isSafeInteger(this.#maxContinuousMs) || this.#maxContinuousMs <= 0 || this.#maxContinuousMs > 300_000) throw new InputArbiterError('invalid')
    this.#options = Object.freeze({ ...options })
    this.#dirty = options.initialJournal.dirty
    this.#phase = this.#dirty ? 'quarantine' : 'idle'
  }

  /** Sanitized snapshot: no operation IDs, scope identifiers, generations or capabilities. */
  get state(): Readonly<InputArbiterState> {
    return this.#run(() => {
      if (this.#phase !== 'quarantine') this.#expire()
      return Object.freeze({ phase: this.#phase, humanExpiresAt: this.#human?.expiresAt ?? null })
    })
  }

  beginAgent(operationId: string): AgentReservation {
    return this.#run(() => {
      this.#expire()
      this.#requireIdle()
      if (!this.#identifier(operationId)) throw new InputArbiterError('invalid')
      this.#admission(false)
      this.#journal(true)
      this.#admission(false)
      const reservation = Object.freeze({ generation: randomBytes(32).toString('hex') }) as AgentReservation
      this.#agent = reservation
      this.#phase = 'agent'
      return reservation
    })
  }

  finishAgent(reservation: AgentReservation, definitive: boolean): void {
    this.#run(() => {
      if (this.#phase !== 'agent' || this.#agent !== reservation) throw new InputArbiterError('denied')
      if (definitive !== true) this.#fail()
      this.#journal(false)
      this.#agent = null
      this.#phase = 'idle'
    })
  }

  acquireHuman(scope: HumanInputScope, maxExpiresAt: number): HumanLease {
    return this.#run(() => {
      this.#expire()
      this.#requireIdle()
      if (!scope || !this.#identifier(scope.workspaceId) || !this.#identifier(scope.sessionId) || !this.#identifier(scope.connectionId)) throw new InputArbiterError('invalid')
      const boundScope = Object.freeze({ workspaceId: scope.workspaceId, sessionId: scope.sessionId, connectionId: scope.connectionId })
      this.#admission(true)
      if (!this.#boolean(() => this.#options.authorizeHuman(boundScope))) throw new InputArbiterError('denied')
      this.#deadline(maxExpiresAt, this.#time())
      this.#journal(true)
      this.#admission(true)
      if (!this.#boolean(() => this.#options.authorizeHuman(boundScope))) throw new InputArbiterError('denied')
      const now = this.#time()
      const expiresAt = this.#deadline(maxExpiresAt, now)
      const lease = Object.freeze({ generation: randomBytes(32).toString('hex') }) as HumanLease
      this.#human = { lease, scope: boundScope, expiresAt, limit: now + this.#maxContinuousMs }
      this.#phase = 'human'
      return lease
    })
  }

  valid(lease: HumanLease): boolean {
    try { return this.#run(() => this.#valid(lease)) } catch { return false }
  }

  /** Only an explicit, still-entitled renewal of this exact authenticated capability. */
  renewHuman(lease: HumanLease, maxExpiresAt: number): HumanLease {
    return this.#run(() => {
      if (!this.#valid(lease)) throw new InputArbiterError('denied')
      const human = this.#human!
      const now = this.#time()
      if (now >= human.expiresAt) {
        this.#phase = 'releasing'
        throw new InputArbiterError('denied')
      }
      const expiresAt = this.#deadline(maxExpiresAt, now, human.limit)
      // Do not let an explicit renewal shorten an already granted deadline.
      human.expiresAt = Math.max(human.expiresAt, expiresAt)
      return lease
    })
  }

  writeHuman(lease: HumanLease, synchronousUpstreamWrite: () => void): void {
    this.#run(() => {
      if (!this.#valid(lease)) throw new InputArbiterError('denied')
      // Last check is here, not when this write was parsed, authorized or queued.
      this.#expire()
      if (this.#phase !== 'human') throw new InputArbiterError('denied')
      this.#void(synchronousUpstreamWrite)
    })
  }

  beginRelease(lease: HumanLease): void {
    this.#run(() => {
      this.#expire()
      if (!this.#human || this.#human.lease !== lease || (this.#phase !== 'human' && this.#phase !== 'releasing')) throw new InputArbiterError('denied')
      this.#phase = 'releasing'
    })
  }

  finishRelease(lease: HumanLease, confirmed: boolean): void {
    this.#run(() => {
      this.#expire()
      if (this.#phase !== 'releasing' || !this.#human || this.#human.lease !== lease) throw new InputArbiterError('denied')
      if (confirmed !== true) this.#fail()
      this.#journal(false)
      this.#human = null
      this.#phase = 'idle'
    })
  }

  /** Host stop/delete/revocation/disconnect hook. Does NOT assert cleanup. */
  revoke(scope: Readonly<{ workspaceId: string; sessionId?: string; connectionId?: string }>): void {
    this.#run(() => {
      this.#expire()
      const bound = this.#human?.scope
      if (bound && scope.workspaceId === bound.workspaceId
        && (scope.sessionId === undefined || scope.sessionId === bound.sessionId)
        && (scope.connectionId === undefined || scope.connectionId === bound.connectionId)
        && this.#phase === 'human') this.#phase = 'releasing'
    })
  }

  /** Any asynchronous upstream/proxy failure, including after socket.write returned. */
  quarantine(): void {
    this.#run(() => { this.#phase = 'quarantine'; this.#journal(true) })
  }

  #valid(lease: HumanLease): boolean {
    this.#expire()
    if (this.#phase !== 'human' || !this.#human || this.#human.lease !== lease) return false
    if (this.#boolean(this.#options.legacyProxyActive)) this.#fail()
    if (this.#boolean(this.#options.cooperativeOwnerPresent)
      || !this.#boolean(() => this.#options.authorizeHuman(this.#human!.scope))) {
      this.#phase = 'releasing'
      return false
    }
    this.#expire()
    return this.#phase === 'human'
  }

  #expire(): void {
    const now = this.#time()
    if (this.#phase === 'human' && this.#human && now >= this.#human.expiresAt) this.#phase = 'releasing'
  }

  #deadline(requested: number, now: number, limit = now + this.#maxContinuousMs): number {
    if (!Number.isSafeInteger(requested) || requested <= now) throw new InputArbiterError('invalid')
    return Math.min(requested, now + this.#maxLeaseMs, limit)
  }

  #identifier(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x20\x7f]/.test(value)
  }

  #requireIdle(): void {
    if (this.#phase !== 'idle') throw new InputArbiterError(this.#phase === 'quarantine' ? 'quarantined' : 'denied')
  }

  #admission(human: boolean): void {
    if ((human && this.#boolean(this.#options.cooperativeOwnerPresent)) || this.#boolean(this.#options.legacyProxyActive)) throw new InputArbiterError('denied')
  }

  #time(): number {
    let now: number
    try { now = (this.#options.now ?? Date.now)() } catch { return this.#fail() }
    if (!Number.isSafeInteger(now) || now < 0 || now < this.#lastNow || now > Number.MAX_SAFE_INTEGER - 300_000 || this.#reentered) return this.#fail()
    this.#lastNow = now
    return now
  }

  #boolean(callback: () => boolean): boolean {
    let result: unknown
    try { result = callback() } catch { return this.#fail() }
    if (typeof result !== 'boolean' || this.#reentered) return this.#fail()
    return result
  }

  #void(callback: () => void): void {
    let result: unknown
    try { result = callback() } catch { this.#fail() }
    if (result !== undefined || this.#reentered) this.#fail()
  }

  #journal(dirty: boolean): void {
    // Conservatively track dirty even when the durable adapter throws mid-write.
    if (dirty) this.#dirty = true
    this.#void(() => this.#options.persistJournal(Object.freeze({ version: 1, dirty })))
    this.#dirty = dirty
  }

  #fail(): never {
    console.warn('[desktop-input] quarantine origin', new Error().stack)
    this.#phase = 'quarantine'
    throw new InputArbiterError('quarantined')
  }

  #run<T>(action: () => T): T {
    if (this.#entered) { this.#reentered = true; this.#phase = 'quarantine'; throw new InputArbiterError('quarantined') }
    this.#entered = true
    try {
      const result = action()
      if (this.#reentered) this.#fail()
      return result
    } catch (error) {
      // Admission may have dirtied the journal before a second check denied.
      // Never expose an idle state with a potentially dirty/ambiguous journal.
      if (this.#phase === 'idle' && this.#dirty) this.#phase = 'quarantine'
      if (this.#phase === 'quarantine') {
        try { this.#options.persistJournal(Object.freeze({ version: 1, dirty: true })) } catch { /* already fail closed */ }
      }
      throw error instanceof InputArbiterError ? error : new InputArbiterError('denied')
    } finally { this.#entered = false; this.#reentered = false }
  }
}
