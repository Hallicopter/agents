import { createServer } from 'node:net'
import type { Socket } from 'node:net'
import { lstat, chmod, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { AgentReservation } from './input-arbiter'
import { InputArbiter } from './input-arbiter'

export interface InputBrokerProcess { readonly pid: number; readonly startTime: string }
export interface InputBrokerCall extends InputBrokerProcess { readonly operationId: string }
export interface UnixInputBroker {
  readonly version: 1
  readonly socketPath: string
  /** Private host-side evidence, not renderer-safe state and NOT peer authentication. */
  registrations(): readonly InputBrokerProcess[]
  activeCalls(): readonly InputBrokerCall[]
  close(): Promise<void>
}

/**
 * Private same-UID broker only. Does not run tools, classify calls, inspect raw
 * arguments, restart services, or establish legacy-proxy coverage. A trusted
 * proxy sends begin immediately BEFORE a mutator and complete only AFTER real
 * upstream completion/definitive nonexecution. Unknown tools must deny in that
 * proxy; queue acceptance, tool timeout and disconnect are NOT completion.
 *
 * Claimed PID/proc startTime are evidence for an independent host /proc scan,
 * NOT SO_PEERCRED or proof of process identity. The existing private parent and
 * its ancestors must be trusted against same-UID/root replacement. No untrusted
 * same-UID process may access this socket. If those conditions cannot be proven,
 * legacyProxyActive must deny admission; this module alone is not live-safe.
 *
 * Protocol version 1: bounded newline JSON, exact fields, one registration OR
 * one begin -> complete pair per connection. No reservation timeout. Killing a
 * broker with an active call leaves the arbiter's durable dirty record intact.
 */
export async function createUnixInputBroker(arbiter: InputArbiter, socketPath: string): Promise<UnixInputBroker> {
  if (!isAbsolute(socketPath) || resolve(socketPath) !== socketPath || Buffer.byteLength(socketPath) > 100) throw new Error('Invalid input broker path')
  const parent = await lstat(dirname(socketPath))
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.geteuid?.() || (parent.mode & 0o077) !== 0) throw new Error('Input broker parent must be private and owned')
  try { await lstat(socketPath) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Input broker path unavailable')
    return listen()
  }
  throw new Error('Input broker path already exists')

  async function listen(): Promise<UnixInputBroker> {
    const clients = new Set<Socket>()
    const registered = new Map<Socket, Readonly<InputBrokerProcess>>()
    const calls = new Map<Socket, Readonly<InputBrokerCall>>()
    let closing: Promise<void> | undefined
    let ready = false
    let socketIdentity: { dev: number; ino: number } | undefined
    const server = createServer(socket => {
      if (!ready || closing || clients.size >= 64) { socket.destroy(); return }
      clients.add(socket)
      let pending = Buffer.alloc(0)
      let state: 'fresh' | 'registered' | 'reserved' | 'finished' | 'failed' = 'fresh'
      let reservation: AgentReservation | undefined
      // Only pre-admission handshake has a deadline. Never time out a reservation.
      const handshakeTimer = setTimeout(() => { if (state === 'fresh') deny() }, 5000)
      handshakeTimer.unref()

      const uncertain = () => {
        if (reservation) {
          console.warn('[desktop-input] agent completion unconfirmed')
          const held = reservation
          reservation = undefined
          try { arbiter.finishAgent(held, false) } catch { /* finishAgent(false) deliberately throws after quarantining */ }
        }
        calls.delete(socket)
      }
      const deny = () => {
        if (state === 'failed' || state === 'finished') return
        state = 'failed'
        clearTimeout(handshakeTimer)
        uncertain()
        registered.delete(socket)
        // Bounded nonsecret error; destroy after flush. No timeout clears a reservation.
        socket.end('{"op":"denied","version":1}\n')
        socket.destroySoon()
      }
      const reply = (op: 'registered' | 'reserved' | 'finished') => {
        socket.write(`${JSON.stringify({ op, version: 1 })}\n`)
      }
      const frame = (bytes: Buffer) => {
        let message: Record<string, unknown>
        try {
          message = parseFlatMessage(bytes.toString('utf8'))
        } catch { deny(); return }
        // Invalid UTF-8 must not acquire a differently interpreted identity.
        if (!Buffer.from(bytes.toString('utf8')).equals(bytes) || message.version !== 1) { deny(); return }
        if (state === 'fresh' && (message.op === 'register' || message.op === 'begin')) {
          const fields = message.op === 'register' ? ['op', 'version', 'pid', 'startTime'] : ['op', 'version', 'pid', 'startTime', 'operationId']
          if (!exact(message, fields) || !validProcess(message)
            || (message.op === 'begin' && !validOperation(message.operationId))) { deny(); return }
          const processRecord = Object.freeze({ pid: message.pid as number, startTime: message.startTime as string })
          if (message.op === 'register') {
            if ([...registered.values()].some(p => p.pid === processRecord.pid && p.startTime === processRecord.startTime)) { deny(); return }
            registered.set(socket, processRecord)
            clearTimeout(handshakeTimer)
            state = 'registered'
            reply('registered')
            return
          }
          try {
            reservation = arbiter.beginAgent(message.operationId as string)
            calls.set(socket, Object.freeze({ ...processRecord, operationId: message.operationId as string }))
            clearTimeout(handshakeTimer)
            state = 'reserved'
            reply('reserved')
          } catch { deny() }
          return
        }
        if (state === 'reserved' && message.op === 'complete' && exact(message, ['op', 'version'])) {
          try {
            // Only this live call connection can confirm its own held reservation.
            arbiter.finishAgent(reservation!, true)
            reservation = undefined
            calls.delete(socket)
            state = 'finished'
            reply('finished')
            socket.end()
          } catch { deny() }
          return
        }
        deny()
      }
      socket.on('data', chunk => {
        if (state === 'failed' || state === 'finished') return
        let offset = 0
        while (offset < chunk.length) {
          const newline = chunk.indexOf(10, offset)
          const end = newline === -1 ? chunk.length : newline
          const slice = chunk.subarray(offset, end)
          if (pending.length + slice.length > 4096) { deny(); return }
          pending = Buffer.concat([pending, slice])
          if (newline === -1) return
          const complete = pending
          pending = Buffer.alloc(0)
          frame(complete)
          if ((state as string) === 'failed' || (state as string) === 'finished') return
          offset = newline + 1
        }
      })
      socket.on('error', () => { uncertain(); state = 'failed'; socket.destroy() })
      socket.on('end', () => {
        if (state !== 'finished') { uncertain(); state = 'failed' }
        registered.delete(socket)
        socket.end()
      })
      socket.on('close', () => {
        clearTimeout(handshakeTimer)
        uncertain()
        registered.delete(socket)
        clients.delete(socket)
      })
    })
    server.on('error', () => {
      if (!ready) return
      try { arbiter.quarantine() } catch { /* already fenced */ }
      for (const socket of clients) socket.destroy()
    })
    await new Promise<void>((accept, reject) => {
      const error = () => { reject(new Error('Input broker listen failed')) }
      server.once('error', error)
      server.listen(socketPath, () => { server.off('error', error); accept() })
    })
    try {
      await chmod(socketPath, 0o600)
      const stat = await lstat(socketPath)
      if (!stat.isSocket() || stat.uid !== process.geteuid?.() || (stat.mode & 0o777) !== 0o600) throw new Error('Input broker socket not private')
      socketIdentity = { dev: stat.dev, ino: stat.ino }
      ready = true
    } catch {
      for (const socket of clients) socket.destroy()
      await new Promise<void>(done => server.close(() => done()))
      throw new Error('Input broker socket setup failed')
    }
    return Object.freeze({
      version: 1 as const,
      socketPath,
      registrations: () => Object.freeze([...registered.values()].map(record => Object.freeze({ ...record }))),
      activeCalls: () => Object.freeze([...calls.values()].map(record => Object.freeze({ ...record }))),
      close: () => {
        if (!closing) {
          // Loss of broker coverage must fence HUMAN input too, not just agent calls.
          ready = false
          try { if (arbiter.state.phase !== 'idle') arbiter.quarantine() } catch { /* journal failure remains fenced */ }
          closing = new Promise<void>(done => {
            for (const socket of clients) socket.destroy()
            server.close(() => done())
          }).then(async () => {
            try {
              const stat = await lstat(socketPath)
              if (stat.isSocket() && stat.dev === socketIdentity?.dev && stat.ino === socketIdentity?.ino) await unlink(socketPath)
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
          })
        }
        return closing
      },
    })
  }
}

function exact(message: Record<string, unknown>, fields: string[]): boolean {
  const keys = Object.keys(message)
  return keys.length === fields.length && fields.every(field => Object.hasOwn(message, field))
}
function validProcess(message: Record<string, unknown>): boolean {
  return Number.isSafeInteger(message.pid) && (message.pid as number) > 0 && (message.pid as number) <= 0x7fffffff
    && typeof message.startTime === 'string' && /^[0-9]{1,24}$/.test(message.startTime)
}
function validOperation(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x20\x7f]/.test(value)
}

/** Flat protocol only; reject duplicate/escaped-duplicate keys, not JSON's last-key-wins. */
function parseFlatMessage(text: string): Record<string, unknown> {
  let offset = 0
  const whitespace = () => { while (offset < text.length && /[\x20\t\r\n]/.test(text[offset]!)) offset++ }
  const string = (): string => {
    if (text[offset] !== '"') throw new Error('Invalid message')
    const start = offset++
    while (offset < text.length) {
      const character = text[offset++]
      if (character === '\\') { offset++; continue }
      if (character === '"') return JSON.parse(text.slice(start, offset)) as string
    }
    throw new Error('Invalid message')
  }
  const result: Record<string, unknown> = Object.create(null)
  whitespace()
  if (text[offset++] !== '{') throw new Error('Invalid message')
  whitespace()
  if (text[offset] !== '}') {
    while (true) {
      const key = string()
      if (Object.hasOwn(result, key)) throw new Error('Invalid message')
      whitespace()
      if (text[offset++] !== ':') throw new Error('Invalid message')
      whitespace()
      if (text[offset] === '"') result[key] = string()
      else {
        const start = offset
        while (offset < text.length && text[offset] !== ',' && text[offset] !== '}') offset++
        const token = text.slice(start, offset).trim()
        if (!/^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)$/.test(token)) throw new Error('Invalid message')
        result[key] = JSON.parse(token)
      }
      whitespace()
      if (text[offset] !== ',') break
      offset++
      whitespace()
    }
  }
  if (text[offset++] !== '}') throw new Error('Invalid message')
  whitespace()
  if (offset !== text.length) throw new Error('Invalid message')
  return result
}
