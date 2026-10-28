/**
 * Управление встроенным сервером хоста, который живёт в отдельном utilityProcess.
 * Если сервер падает, UI хоста продолжает работать, а статус показывает ошибку.
 */
import { app, utilityProcess, type UtilityProcess } from 'electron'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import type { HostSettings, HostStatus } from '../preload/api'
import type { ParentToServer, ServerConfig, ServerToParent } from '../server/config'
import type { Logger } from '../server/logger'

const START_TIMEOUT_MS = 20_000
const STOP_TIMEOUT_MS = 5_000

export class HostController extends EventEmitter {
  private child: UtilityProcess | null = null
  private status: HostStatus = {
    state: 'stopped',
    port: null,
    fingerprint: null,
    addresses: [],
    online: 0,
    error: null,
    rtcPort: null,
    voiceError: null
  }
  private stopping = false

  constructor(
    private log: Logger,
    private dataDir: string,
    private adminToken: string,
    /** Путь к mediasoup-worker в собранном приложении (в режиме разработки — null). */
    private workerBin: string | null
  ) {
    super()
  }

  getStatus(): HostStatus {
    return this.status
  }

  isRunning(): boolean {
    return this.child !== null && (this.status.state === 'running' || this.status.state === 'starting')
  }

  private setStatus(patch: Partial<HostStatus>): void {
    this.status = { ...this.status, ...patch }
    this.emit('status', this.status)
  }

  private send(msg: ParentToServer): void {
    this.child?.postMessage(msg)
  }

  async start(settings: HostSettings): Promise<HostStatus> {
    if (this.child) {
      if (this.status.state === 'running') return this.status
      throw new Error('Сервер уже запускается или останавливается')
    }
    this.setStatus({ state: 'starting', error: null, port: settings.port, addresses: [], fingerprint: null, online: 0 })
    const entry = join(__dirname, 'server.js')
    this.log.info(`Запускаю сервер хоста: ${entry}`)

    let child: UtilityProcess
    try {
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v
      if (this.workerBin) env.MEDIASOUP_WORKER_BIN = this.workerBin
      child = utilityProcess.fork(entry, [], { serviceName: 'Zvon Host Server', stdio: 'pipe', env })
    } catch (err) {
      const message = `Не удалось запустить процесс сервера: ${(err as Error).message}`
      this.setStatus({ state: 'error', error: message })
      throw new Error(message)
    }
    this.child = child
    this.stopping = false

    child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(`[host] ${chunk.toString()}`))
    child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[host] ${chunk.toString()}`))

    const config: ServerConfig = {
      port: settings.port,
      bindAddress: '0.0.0.0',
      serverName: settings.serverName,
      password: settings.password,
      adminToken: this.adminToken,
      dataDir: this.dataDir,
      version: app.getVersion(),
      rtcPort: settings.rtcPort,
      rtcIps: [],
      maxUploadMb: settings.maxUploadMb
    }

    return new Promise<HostStatus>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        const message = 'Сервер не запустился за 20 секунд (подробности в логах)'
        this.setStatus({ state: 'error', error: message })
        child.kill()
        reject(new Error(message))
      }, START_TIMEOUT_MS)

      child.on('message', (raw: unknown) => {
        const msg = raw as ServerToParent
        switch (msg.type) {
          case 'ready':
            this.setStatus({
              state: 'running',
              port: msg.port,
              fingerprint: msg.fingerprint,
              addresses: msg.addresses,
              error: null,
              rtcPort: msg.rtcPort,
              voiceError: msg.voiceError
            })
            this.log.info(`Сервер хоста запущен на порту ${msg.port}, медиа ${msg.rtcPort}${msg.voiceError ? ` (голос недоступен: ${msg.voiceError})` : ''}`)
            if (!settled) {
              settled = true
              clearTimeout(timer)
              resolve(this.status)
            }
            break
          case 'fatal':
            this.log.error(`Сервер хоста сообщил о фатальной ошибке: ${msg.message}`)
            this.setStatus({ state: 'error', error: msg.message })
            if (!settled) {
              settled = true
              clearTimeout(timer)
              reject(new Error(msg.message))
            }
            break
          case 'online':
            this.setStatus({ online: msg.count })
            break
          case 'settings':
            this.emit('settings', { maxUploadMb: msg.maxUploadMb })
            break
          case 'stopped':
            this.log.info('Сервер хоста подтвердил остановку')
            break
        }
      })

      child.on('exit', (code) => {
        this.log.info(`Процесс сервера завершился с кодом ${code}`)
        this.child = null
        clearTimeout(timer)
        if (this.stopping || code === 0) {
          this.setStatus({ state: 'stopped', online: 0, addresses: [], error: null })
        } else if (this.status.state !== 'error') {
          this.setStatus({ state: 'error', online: 0, error: `Сервер неожиданно завершился (код ${code})` })
        }
        this.emit('exit', code)
        if (!settled) {
          settled = true
          reject(new Error(this.status.error ?? 'Сервер завершился до запуска'))
        }
      })

      this.send({ type: 'start', config })
    })
  }

  async stop(reason = 'Хост остановил сервер'): Promise<HostStatus> {
    const child = this.child
    if (!child) {
      this.setStatus({ state: 'stopped', online: 0, error: null })
      return this.status
    }
    this.stopping = true
    this.setStatus({ state: 'stopping' })
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        this.log.warn('Сервер не остановился вовремя, завершаю принудительно')
        child.kill()
        resolve()
      }, STOP_TIMEOUT_MS)
      this.once('exit', () => {
        clearTimeout(killTimer)
        resolve()
      })
      this.send({ type: 'stop', reason })
    })
    return this.status
  }
}
