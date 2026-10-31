import { connect } from 'node:net'
import type { Socket } from 'node:net'
import { isAbsolute, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

// Provisional read candidates only: production integration MUST audit the exact
// SDK version for implicit session/cursor/permission side effects before use.
const READ_ONLY = new Set(['list_apps', 'list_windows', 'get_screen_size', 'health_report'])
// State captures are always reserved: screenshot_out_file writes and default
// action-snapshot registration mean their names do NOT establish read-only behavior.
const MUTATORS = new Set(['launch_app', 'click', 'double_click', 'right_click', 'drag', 'type_text', 'press_key', 'hotkey', 'scroll', 'check_permissions', 'start_session', 'end_session', 'get_window_state', 'get_desktop_state'])

export interface CuaBrokerClientOptions<T> {
  /** Fixed host configuration only; never accept this path or identity from tool arguments. */
  readonly socketPath: string
  readonly pid: number
  readonly startTime: string
  /**
   * Trusted SDK boundary: resolves ONLY on actual upstream handler completion,
   * not dispatch, buffering, job submission, timeout, or local cancellation.
   * Fulfilled isError results are definitive completed handlers, not nonexecution.
   * Existing cooperative owner-token checks MUST remain in this upstream callback
   * for every call, including reads. A name allowlist is not owner authorization.
   */
  readonly upstream: (name: string, args: unknown) => Promise<T>
  readonly brokerTimeoutMs?: number
  readonly completionTimeoutMs?: number
}
export interface CuaBrokerClient<T> {
  /** Zero queue: concurrent/reentrant requests deny immediately, with no replay. */
  callTool(name: string, args: unknown, options?: { readonly signal?: AbortSignal }): Promise<T>
  /** Disconnects any active reservation WITHOUT asserting completion. */
  close(): void
}
export class CuaBrokerClientError extends Error {
  constructor(readonly code: 'denied' | 'unavailable' | 'uncertain') {
    super(`CUA broker ${code}`)
    this.name = 'CuaBrokerClientError'
  }
}

/**
 * Trusted same-UID application client, NOT a security boundary against arbitrary
 * local code that can already call the upstream SDK. PID/startTime registration
 * is coverage evidence, NOT authenticated peer identity. Does not install a
 * proxy, modify sources, acquire/clear cooperative owners, or recover quarantine.
 *
 * Every mutator has a fresh persistent begin/complete connection. Any uncertainty
 * after reservation destroys it, leaving the broker dirty/quarantined; deadlines
 * NEVER turn into finish/idle. A hung upstream may continue after local rejection:
 * human ownership must remain blocked until external reconciliation proves stop.
 * No automatic retries, reconnect, queue, renewal or operation replay exists.
 *
 * Socket health is checked synchronously immediately before invoking upstream.
 * Kernel peer death may still race that invocation; the durable dirty reservation
 * and broker shutdown quarantine, not a socket-health guess, exclude humans then.
 */
export async function createCuaBrokerClient<T>(options: CuaBrokerClientOptions<T>): Promise<CuaBrokerClient<T>> {
  if (!options || typeof options.socketPath !== 'string' || !isAbsolute(options.socketPath)
    || resolve(options.socketPath) !== options.socketPath || Buffer.byteLength(options.socketPath) > 100
    || !Number.isSafeInteger(options.pid) || options.pid <= 0 || options.pid > 0x7fffffff
    || typeof options.startTime !== 'string' || !/^[0-9]{1,24}$/.test(options.startTime)
    || typeof options.upstream !== 'function') throw new CuaBrokerClientError('denied')
  const brokerTimeoutMs = options.brokerTimeoutMs ?? 5000
  const completionTimeoutMs = options.completionTimeoutMs ?? 300_000
  if (!bounded(brokerTimeoutMs, 5000) || !bounded(completionTimeoutMs, 300_000)) throw new CuaBrokerClientError('denied')
  // Capture immutable host configuration, not a mutable options object.
  const { socketPath, pid, startTime, upstream } = options
  const registration = new BrokerChannel(socketPath)
  try {
    await registration.connected(brokerTimeoutMs)
    await registration.request({ op: 'register', version: 1, pid, startTime }, 'registered', brokerTimeoutMs)
  } catch {
    registration.destroy()
    throw new CuaBrokerClientError('unavailable')
  }
  let closed = false
  let busy = false
  let active: BrokerChannel | undefined
  void registration.failure.catch(() => {
    closed = true
    active?.destroy()
  })
  const assertReady = (signal?: AbortSignal) => {
    if (closed || !registration.alive || (active && !active.alive) || signal?.aborted) throw new CuaBrokerClientError('unavailable')
  }
  return Object.freeze({
    callTool: async (name: string, args: unknown, callOptions?: { readonly signal?: AbortSignal }): Promise<T> => {
      if (typeof name !== 'string' || (!READ_ONLY.has(name) && !MUTATORS.has(name)) || busy) throw new CuaBrokerClientError('denied')
      const signal = callOptions?.signal
      assertReady(signal)
      busy = true
      let dispatched = false
      try {
        if (MUTATORS.has(name)) {
          active = new BrokerChannel(socketPath)
          await active.connected(brokerTimeoutMs, signal)
          assertReady(signal)
          await active.request({ op: 'begin', version: 1, operationId: randomBytes(32).toString('hex'), pid, startTime }, 'reserved', brokerTimeoutMs, signal)
        }
        // No await or deferred dispatch between this check and actual invocation.
        assertReady(signal)
        dispatched = true
        const pending = upstream(name, args)
        if (!pending || typeof pending.then !== 'function') throw new CuaBrokerClientError('uncertain')
        const result = await completion(pending, [registration.failure, ...(active ? [active.failure] : [])], completionTimeoutMs, signal)
        if (active) {
          assertReady(signal)
          await active.request({ op: 'complete', version: 1 }, 'finished', brokerTimeoutMs, signal)
        }
        return result
      } catch {
        // A rejected/aborted/timed-out upstream is NOT proof of nonexecution.
        // Retire the client on mutator uncertainty, even if the registration's
        // close event has not arrived yet. No subsequent reads/mutators dispatch.
        if (dispatched && active) { closed = true; registration.destroy() }
        throw new CuaBrokerClientError(dispatched ? 'uncertain' : 'unavailable')
      } finally {
        active?.destroy()
        active = undefined
        busy = false
      }
    },
    close: () => { closed = true; active?.destroy(); registration.destroy() },
  })
}

function bounded(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum
}

/** One expected bounded response at a time; unsolicited/malformed data closes the channel. */
class BrokerChannel {
  readonly #socket: Socket
  readonly failure: Promise<never>
  #rejectFailure!: (reason: CuaBrokerClientError) => void
  #failed = false
  #connected = false
  #pending = Buffer.alloc(0)
  #waiting: { op: string; resolve: () => void; reject: (reason: CuaBrokerClientError) => void } | undefined
  #connection: Promise<void>

  constructor(path: string) {
    this.failure = new Promise<never>((_, reject) => { this.#rejectFailure = reject })
    // Every channel can fail after its last waiter completed; never leak rejection.
    void this.failure.catch(() => {})
    this.#socket = connect(path)
    this.#connection = new Promise<void>(accept => {
      this.#socket.once('connect', () => { this.#connected = true; accept() })
    })
    this.#socket.on('error', () => this.destroy())
    this.#socket.on('end', () => this.destroy())
    this.#socket.on('close', () => this.destroy())
    this.#socket.on('data', bytes => {
      if (this.#failed) return
      // Broker responses are tiny. Bound total data, not only newline-free tails.
      if (this.#pending.length + bytes.length > 4096) { this.destroy(); return }
      this.#pending = Buffer.concat([this.#pending, bytes])
      const newline = this.#pending.indexOf(10)
      if (newline === -1) return
      if (newline !== this.#pending.length - 1 || !this.#waiting) { this.destroy(); return }
      try {
        const raw = this.#pending.subarray(0, newline)
        const text = raw.toString('utf8')
        const message: unknown = JSON.parse(text)
        if (!Buffer.from(text).equals(raw) || !message || typeof message !== 'object' || Array.isArray(message)) throw new Error()
        const record = message as Record<string, unknown>
        if (Object.keys(record).length !== 2 || record.version !== 1 || record.op !== this.#waiting.op) throw new Error()
        // The broker emits this exact canonical shape; duplicate keys/whitespace are not a second dialect.
        if (text !== JSON.stringify({ op: this.#waiting.op, version: 1 })) throw new Error()
        this.#pending = Buffer.alloc(0)
        const waiting = this.#waiting
        this.#waiting = undefined
        waiting.resolve()
      } catch { this.destroy() }
    })
  }

  get alive(): boolean {
    return this.#connected && !this.#failed && !this.#socket.destroyed && !this.#socket.readableEnded && !this.#socket.writableEnded
  }

  async connected(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    await completion(this.#connection, [this.failure], timeoutMs, signal)
    if (!this.alive) throw new CuaBrokerClientError('unavailable')
  }

  async request(message: Record<string, unknown>, op: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (!this.alive || this.#waiting || signal?.aborted) throw new CuaBrokerClientError('unavailable')
    const response = new Promise<void>((accept, reject) => { this.#waiting = { op, resolve: accept, reject } })
    void response.catch(() => {})
    try {
      this.#socket.write(`${JSON.stringify(message)}\n`)
      await completion(response, [this.failure], timeoutMs, signal)
    } catch { this.destroy(); throw new CuaBrokerClientError('unavailable') }
  }

  destroy(): void {
    if (this.#failed) return
    this.#failed = true
    const error = new CuaBrokerClientError('unavailable')
    this.#waiting?.reject(error)
    this.#waiting = undefined
    this.#rejectFailure(error)
    this.#socket.destroy()
  }
}

async function completion<T>(pending: Promise<T>, blockers: readonly Promise<never>[], timeoutMs: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  const stop = new Promise<never>((_, reject) => {
    const fail = () => reject(new CuaBrokerClientError('uncertain'))
    timer = setTimeout(fail, timeoutMs)
    abort = fail
    if (signal?.aborted) fail()
    else signal?.addEventListener('abort', fail, { once: true })
  })
  try { return await Promise.race([pending, ...blockers, stop]) }
  finally {
    if (timer !== undefined) clearTimeout(timer)
    if (abort) signal?.removeEventListener('abort', abort)
  }
}
