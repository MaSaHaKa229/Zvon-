/**
 * Обёртка над mediasoup: один Worker, один WebRtcServer (общий порт для всех транспортов),
 * роутеры по голосовым каналам. При падении воркера сервис перезапускает его
 * и сообщает об этом событием 'reset'.
 */
import { EventEmitter } from 'node:events'
import * as mediasoup from 'mediasoup'
import { BITRATE } from '../shared/constants'
import type { ServerConfig } from './config'
import { listAddresses } from './interfaces'
import type { Logger } from './logger'

export type Worker = mediasoup.types.Worker
export type Router = mediasoup.types.Router
export type WebRtcServer = mediasoup.types.WebRtcServer
export type WebRtcTransport = mediasoup.types.WebRtcTransport
export type Producer = mediasoup.types.Producer
export type Consumer = mediasoup.types.Consumer
export type RtpCapabilities = mediasoup.types.RtpCapabilities

type RouterOptions = NonNullable<Parameters<Worker['createRouter']>[0]>
type WebRtcServerOptions = Parameters<Worker['createWebRtcServer']>[0]
type ListenInfo = WebRtcServerOptions['listenInfos'][number]

/**
 * Кодеки роутера. Opus — голос; VP8 — камера (simulcast); VP9 — экран (SVC);
 * H.264 — запасной вариант для устройств с аппаратным кодеком.
 */
export const MEDIA_CODECS: RouterOptions['mediaCodecs'] = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, parameters: { 'x-google-start-bitrate': 1000 } },
  { kind: 'video', mimeType: 'video/VP9', clockRate: 90000, parameters: { 'profile-id': 0, 'x-google-start-bitrate': 1000 } },
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: { 'packetization-mode': 1, 'profile-level-id': '42e01f', 'level-asymmetry-allowed': 1, 'x-google-start-bitrate': 1000 }
  }
]

const MAX_RESTARTS = 5

export interface SfuStats {
  workerPid: number | null
  /** Загрузка CPU воркером с прошлого замера, % одного ядра. */
  cpuPercent: number
  routers: number
}

export interface BitrateLimits {
  /** Максимум от одного клиента, бит/с. */
  incoming: number
  /** Максимум к одному клиенту, бит/с (0 — без ограничения). */
  outgoing: number
}

function describeError(err: unknown, port: number): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/EADDRINUSE|address already in use/i.test(msg)) return `Порт медиа ${port} уже занят. Выберите другой порт для голоса.`
  if (/EACCES|permission denied/i.test(msg)) return `Нет прав открыть порт медиа ${port}.`
  if (/ENOENT|spawn/i.test(msg)) return 'Не найден исполняемый файл mediasoup-worker. Переустановите приложение.'
  return msg
}

export class SfuService extends EventEmitter {
  private worker: Worker | null = null
  private webRtcServer: WebRtcServer | null = null
  private restarts = 0
  private closing = false
  private routers = new Set<Router>()
  /** null — работает; иначе текст ошибки для пользователя. */
  error: string | null = 'SFU ещё не запущен'
  /** Адреса, которые реально объявлены клиентам как ICE-кандидаты. */
  listenIps: string[] = []
  limits: BitrateLimits = { incoming: BITRATE.maxIncomingPerTransport, outgoing: 0 }
  private lastCpu: { cpuMs: number; at: number } | null = null

  constructor(
    private cfg: ServerConfig,
    private log: Logger
  ) {
    super()
  }

  get available(): boolean {
    return this.worker !== null && this.webRtcServer !== null && this.error === null
  }

  async start(): Promise<void> {
    try {
      await this.spawn()
      this.error = null
    } catch (err) {
      this.error = describeError(err, this.cfg.rtcPort)
      this.log.error(`SFU не запустился: ${this.error}`, err)
    }
  }

  private resolveIps(): string[] {
    if (this.cfg.rtcIps.length > 0) return [...new Set(this.cfg.rtcIps)]
    // Все IPv4-адреса машины, включая 127.0.0.1 (для клиента самого хоста).
    return [...new Set(listAddresses(true).map((a) => a.address))]
  }

  private async spawn(): Promise<void> {
    const worker = await mediasoup.createWorker({ logLevel: 'warn', logTags: ['ice', 'dtls', 'rtp', 'rtcp', 'srtp'] })
    this.log.info(`mediasoup-worker запущен, pid ${worker.pid}`)
    worker.on('died', (err) => this.onWorkerDied(worker, err))

    const ips = this.resolveIps()
    const perIp: ListenInfo[] = ips.flatMap((ip): ListenInfo[] => [
      { protocol: 'udp', ip, port: this.cfg.rtcPort },
      { protocol: 'tcp', ip, port: this.cfg.rtcPort }
    ])
    let server: WebRtcServer
    try {
      server = await worker.createWebRtcServer({ listenInfos: perIp })
      this.listenIps = ips
    } catch (err) {
      // Какой-то адаптер мог исчезнуть между перечислением и привязкой — слушаем на всех адресах сразу.
      this.log.warn(`Не удалось привязаться к адресам по отдельности (${(err as Error).message}), пробую 0.0.0.0`)
      const announced = listAddresses(false)[0]?.address
      if (!announced) {
        worker.close()
        throw err
      }
      try {
        server = await worker.createWebRtcServer({
          listenInfos: [
            { protocol: 'udp', ip: '0.0.0.0', announcedAddress: announced, port: this.cfg.rtcPort },
            { protocol: 'tcp', ip: '0.0.0.0', announcedAddress: announced, port: this.cfg.rtcPort }
          ]
        })
        this.listenIps = [announced]
      } catch (err2) {
        worker.close()
        throw err2
      }
    }
    this.worker = worker
    this.webRtcServer = server
    this.log.info(`Медиа слушает порт ${this.cfg.rtcPort} (UDP и TCP) на: ${this.listenIps.join(', ')}`)
  }

  private onWorkerDied(worker: Worker, err: Error): void {
    if (this.worker !== worker || this.closing) return
    this.log.error('mediasoup-worker неожиданно завершился', err)
    this.worker = null
    this.webRtcServer = null
    this.routers.clear()
    this.error = 'Медиасервер перезапускается…'
    this.emit('reset', 'Медиасервер перезапущен после сбоя')
    if (this.restarts >= MAX_RESTARTS) {
      this.error = 'Медиасервер несколько раз упал подряд. Перезапустите сервер хоста.'
      return
    }
    this.restarts++
    setTimeout(() => {
      void this.start().then(() => {
        if (this.available) this.log.info('mediasoup-worker перезапущен')
      })
    }, 2000)
  }

  async createRouter(): Promise<Router> {
    if (!this.worker || !this.available) throw new Error(this.error ?? 'SFU недоступен')
    const router = await this.worker.createRouter({ mediaCodecs: MEDIA_CODECS })
    this.routers.add(router)
    router.observer.on('close', () => this.routers.delete(router))
    return router
  }

  async createTransport(router: Router, appData: Record<string, unknown>): Promise<WebRtcTransport> {
    if (!this.webRtcServer) throw new Error(this.error ?? 'SFU недоступен')
    const transport = await router.createWebRtcTransport({
      webRtcServer: this.webRtcServer,
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: BITRATE.initialOutgoing,
      appData
    })
    await this.applyLimits(transport)
    return transport
  }

  /** Применяет текущие лимиты: к транспорту отправки — входящий, к транспорту приёма — исходящий. */
  async applyLimits(transport: WebRtcTransport): Promise<void> {
    try {
      if (transport.appData.direction === 'send') await transport.setMaxIncomingBitrate(this.limits.incoming)
      else if (this.limits.outgoing > 0) await transport.setMaxOutgoingBitrate(this.limits.outgoing)
    } catch (err) {
      this.log.warn('Не удалось применить ограничение битрейта', err)
    }
  }

  async stats(): Promise<SfuStats> {
    if (!this.worker) return { workerPid: null, cpuPercent: 0, routers: 0 }
    try {
      const usage = await this.worker.getResourceUsage()
      const cpuMs = usage.ru_utime + usage.ru_stime
      const now = Date.now()
      let cpuPercent = 0
      if (this.lastCpu && now > this.lastCpu.at) {
        cpuPercent = Math.max(0, ((cpuMs - this.lastCpu.cpuMs) / (now - this.lastCpu.at)) * 100)
      }
      this.lastCpu = { cpuMs, at: now }
      return { workerPid: this.worker.pid, cpuPercent: Math.round(cpuPercent * 10) / 10, routers: this.routers.size }
    } catch {
      return { workerPid: this.worker.pid, cpuPercent: 0, routers: this.routers.size }
    }
  }

  close(): void {
    this.closing = true
    try {
      this.worker?.close()
    } catch (err) {
      this.log.warn('Ошибка остановки mediasoup-worker', err)
    }
    this.worker = null
    this.webRtcServer = null
  }
}
