/**
 * WebSocket-клиент Zvon: запрос/ответ поверх JSON-конвертов, события сервера,
 * ping, автоматическое переподключение с экспоненциальной задержкой.
 */
import { CloseCode, ErrorCode, PROTOCOL_VERSION, TIMINGS } from '../../../shared/constants'
import type {
  ErrorPayload,
  EventMap,
  EventType,
  RequestMap,
  RequestType,
  ResponseMap,
  ServerEnvelope,
  ServerSnapshot
} from '../../../shared/types'

export type ConnStatus = 'connecting' | 'online' | 'reconnecting' | 'closed'

export interface ConnectTarget {
  host: string
  port: number
  hello: Omit<RequestMap['hello'], 'protocol'>
}

export interface ClientHooks {
  onStatus(status: ConnStatus, attempt: number): void
  /** Успешный вход (в том числе после переподключения). */
  onWelcome(snapshot: ServerSnapshot, isReconnect: boolean): void
  /** Неустранимая ошибка: переподключаться бессмысленно. */
  onFatal(message: string, code: string): void
}

export class ServerError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message)
  }
}

interface Pending {
  resolve(value: unknown): void
  reject(err: Error): void
  timer: ReturnType<typeof setTimeout>
}

const REQUEST_TIMEOUT_MS = 15_000
const MAX_BACKOFF_MS = 30_000

/** Ошибки hello, после которых переподключаться бессмысленно (в т. ч. блокировка хостом). */
const FATAL_CODES = new Set<string>([ErrorCode.WrongPassword, ErrorCode.VersionMismatch, ErrorCode.Forbidden])

export class ZvonClient {
  private ws: WebSocket | null = null
  private nextId = 1
  private pending = new Map<number, Pending>()
  private listeners = new Map<string, Set<(d: unknown) => void>>()
  private attempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private everWelcomed = false
  private stopped = false
  private firstConnect: { resolve(s: ServerSnapshot): void; reject(e: Error): void } | null = null
  private readonly onBrowserOnline = (): void => {
    if (this.reconnectTimer && !this.stopped) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
      this.open()
    }
  }

  status: ConnStatus = 'connecting'

  constructor(
    private target: ConnectTarget,
    private hooks: ClientHooks
  ) {}

  get url(): string {
    return `wss://${this.target.host}:${this.target.port}/ws`
  }

  /** Первое подключение: промис завершается после hello или ошибки (без автоповтора). */
  connect(): Promise<ServerSnapshot> {
    window.addEventListener('online', this.onBrowserOnline)
    return new Promise<ServerSnapshot>((resolve, reject) => {
      this.firstConnect = { resolve, reject }
      this.open()
    })
  }

  /** Окончательное отключение без переподключения. */
  close(): void {
    this.stopped = true
    window.removeEventListener('online', this.onBrowserOnline)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.stopPing()
    const ws = this.ws
    this.ws = null
    if (ws) {
      this.detach(ws)
      try {
        ws.close(CloseCode.Normal, 'bye')
      } catch {
        /* ignore */
      }
    }
    this.rejectAll(new Error('Соединение закрыто'))
    this.setStatus('closed')
  }

  /** Обновляет данные hello (например, после смены ника) для будущих переподключений. */
  updateHello(patch: Partial<ConnectTarget['hello']>): void {
    this.target = { ...this.target, hello: { ...this.target.hello, ...patch } }
  }

  on<E extends EventType>(event: E, handler: (d: EventMap[E]) => void): () => void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    const h = handler as (d: unknown) => void
    set.add(h)
    return () => set!.delete(h)
  }

  request<K extends RequestType>(type: K, data: RequestMap[K], timeoutMs = REQUEST_TIMEOUT_MS): Promise<ResponseMap[K]> {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN || (this.status !== 'online' && type !== 'hello')) {
      return Promise.reject(new ServerError('offline', 'Нет соединения с сервером'))
    }
    return this.rawRequest(ws, type, data, timeoutMs)
  }

  /* ======================= внутреннее ======================= */

  private rawRequest<K extends RequestType>(ws: WebSocket, type: K, data: RequestMap[K], timeoutMs: number): Promise<ResponseMap[K]> {
    const id = this.nextId++
    return new Promise<ResponseMap[K]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new ServerError('timeout', 'Сервер не ответил вовремя'))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      try {
        ws.send(JSON.stringify({ t: type, id, d: data }))
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new ServerError('offline', `Не удалось отправить: ${(err as Error).message}`))
      }
    })
  }

  private setStatus(status: ConnStatus): void {
    this.status = status
    this.hooks.onStatus(status, this.attempt)
  }

  private open(): void {
    if (this.stopped) return
    this.setStatus(this.everWelcomed ? 'reconnecting' : 'connecting')
    let ws: WebSocket
    try {
      ws = new WebSocket(this.url)
    } catch (err) {
      this.handleClosed(null, 0, (err as Error).message)
      return
    }
    this.ws = ws
    ws.onopen = () => {
      void this.sayHello(ws)
    }
    ws.onmessage = (ev) => this.onMessage(ev.data)
    ws.onclose = (ev) => this.handleClosed(ws, ev.code, ev.reason)
    ws.onerror = () => {
      /* подробности придут в onclose */
    }
  }

  private detach(ws: WebSocket): void {
    ws.onopen = null
    ws.onmessage = null
    ws.onclose = null
    ws.onerror = null
  }

  private async sayHello(ws: WebSocket): Promise<void> {
    try {
      const snapshot = await this.rawRequest(ws, 'hello', { protocol: PROTOCOL_VERSION, ...this.target.hello }, REQUEST_TIMEOUT_MS)
      if (ws !== this.ws) return
      const isReconnect = this.everWelcomed
      this.everWelcomed = true
      this.attempt = 0
      // Сервер мог переименовать ник (если он занят) — запоминаем итоговый.
      this.target.hello.nickname = snapshot.you.nickname
      this.setStatus('online')
      this.startPing()
      if (this.firstConnect) {
        this.firstConnect.resolve(snapshot)
        this.firstConnect = null
      }
      this.hooks.onWelcome(snapshot, isReconnect)
    } catch (err) {
      const e = err as ServerError
      if (FATAL_CODES.has(e.code)) {
        this.fail(e.message, e.code)
      } else if (ws === this.ws) {
        // Временная проблема — закрываем сокет, дальше сработает переподключение.
        this.dropSocket(e.message)
      }
    }
  }

  private fail(message: string, code: string): void {
    const first = this.firstConnect
    this.firstConnect = null
    this.close()
    if (first) first.reject(new ServerError(code, message))
    else this.hooks.onFatal(message, code)
  }

  private onMessage(raw: unknown): void {
    if (typeof raw !== 'string') return
    let env: ServerEnvelope
    try {
      env = JSON.parse(raw) as ServerEnvelope
    } catch {
      console.warn('[zvon] неверный кадр от сервера')
      return
    }
    if (env.t === 'res') {
      const p = this.pending.get(env.id)
      if (!p) return
      this.pending.delete(env.id)
      clearTimeout(p.timer)
      if (env.ok) p.resolve(env.d)
      else {
        const e = (env as { err: ErrorPayload }).err
        p.reject(new ServerError(e.code, e.message))
      }
      return
    }
    const set = this.listeners.get(env.t)
    if (!set) return
    for (const h of set) {
      try {
        h(env.d)
      } catch (err) {
        console.error(`[zvon] ошибка обработчика события ${env.t}`, err)
      }
    }
  }

  private startPing(): void {
    this.stopPing()
    this.pingTimer = setInterval(() => {
      const ws = this.ws
      if (!ws || this.status !== 'online') return
      this.rawRequest(ws, 'ping', {}, TIMINGS.clientPingTimeoutMs).catch(() => {
        if (ws === this.ws) this.dropSocket('ping timeout')
      })
    }, TIMINGS.clientPingIntervalMs)
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
  }

  /** Немедленно бросает «подвисший» сокет, не дожидаясь закрывающего рукопожатия. */
  private dropSocket(reason: string): void {
    const ws = this.ws
    if (!ws) return
    this.detach(ws)
    try {
      ws.close(3000, reason.slice(0, 60))
    } catch {
      /* ignore */
    }
    this.handleClosed(ws, 3000, reason)
  }

  private rejectAll(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }

  private handleClosed(ws: WebSocket | null, code: number, reason: string): void {
    if (ws && ws !== this.ws) return
    if (ws) this.detach(ws)
    this.ws = null
    this.stopPing()
    this.rejectAll(new ServerError('offline', 'Соединение потеряно'))
    if (this.stopped) return

    if (code === CloseCode.Replaced) return this.fail('replaced', 'replaced')
    if (code === CloseCode.Kicked) return this.fail('kicked', 'kicked')

    if (!this.everWelcomed) {
      // Первое подключение не удалось — сообщаем сразу, без бесконечных повторов.
      const first = this.firstConnect
      this.firstConnect = null
      this.close()
      first?.reject(new ServerError(code === CloseCode.AuthFailed ? 'auth_failed' : 'handshake', reason || `code ${code}`))
      return
    }
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    this.attempt++
    const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(this.attempt - 1, 5))
    const delay = base / 2 + Math.random() * (base / 2)
    this.setStatus('reconnecting')
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.open()
    }, delay)
  }
}
