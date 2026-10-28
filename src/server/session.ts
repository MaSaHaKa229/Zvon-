import type { WebSocket } from 'ws'
import type { ErrorCode } from '../shared/constants'
import type { EventMap, EventType, ServerEnvelope } from '../shared/types'
import type { Logger } from './logger'

/** Ошибка обработчика запроса, которая уходит клиенту как {ok:false}. */
export class RequestError extends Error {
  constructor(
    public code: ErrorCode,
    message: string
  ) {
    super(message)
  }
}

const BUCKET_CAPACITY = 20
const BUCKET_REFILL_PER_SEC = 5

/** Одно WebSocket-подключение. После hello получает userId. */
export class ClientSession {
  userId: string | null = null
  nickname = ''
  isAdmin = false
  isAlive = true
  /** Токен для HTTP-доступа к файлам, выдаётся при входе. */
  fileToken = ''
  readonly connectedAt = Date.now()
  lastTypingAt = 0
  badFrames = 0
  helloTimer: NodeJS.Timeout | null = null
  private tokens = BUCKET_CAPACITY
  private lastRefill = Date.now()

  constructor(
    readonly ws: WebSocket,
    readonly connId: number,
    readonly remoteAddress: string,
    private log: Logger
  ) {}

  get authenticated(): boolean {
    return this.userId !== null
  }

  get label(): string {
    return this.userId ? `${this.nickname}#${this.connId}` : `conn#${this.connId}(${this.remoteAddress})`
  }

  private send(env: ServerEnvelope): void {
    if (this.ws.readyState !== this.ws.OPEN) return
    try {
      this.ws.send(JSON.stringify(env))
    } catch (err) {
      this.log.warn(`Не удалось отправить ${this.label}`, err)
    }
  }

  reply(id: number, data: unknown): void {
    this.send({ t: 'res', id, ok: true, d: data })
  }

  replyError(id: number, code: ErrorCode, message: string): void {
    this.send({ t: 'res', id, ok: false, err: { code, message } })
  }

  event<E extends EventType>(t: E, d: EventMap[E]): void {
    this.send({ t, d })
  }

  /** Ограничение частоты запросов (token bucket). */
  take(cost = 1): boolean {
    const now = Date.now()
    const elapsed = (now - this.lastRefill) / 1000
    this.lastRefill = now
    this.tokens = Math.min(BUCKET_CAPACITY, this.tokens + elapsed * BUCKET_REFILL_PER_SEC)
    if (this.tokens < cost) return false
    this.tokens -= cost
    return true
  }

  close(code: number, reason: string): void {
    try {
      // Даём уйти уже поставленному в очередь ответу, затем закрываем.
      setTimeout(() => {
        if (this.ws.readyState === this.ws.OPEN || this.ws.readyState === this.ws.CONNECTING) {
          this.ws.close(code, reason)
        }
      }, 50)
    } catch (err) {
      this.log.warn(`Ошибка закрытия ${this.label}`, err)
    }
  }
}
