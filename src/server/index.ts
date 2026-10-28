/**
 * Встроенный сервер хоста Zvon.
 *
 * Режимы запуска:
 *  1. Из приложения: main-процесс делает utilityProcess.fork(server.js) и присылает {type:'start', config}.
 *  2. Без интерфейса (для тестов и «безголового» хоста):
 *     ELECTRON_RUN_AS_NODE=1 electron out/main/server.js --data ./host-data --port 7777 --password secret
 */
import { mkdirSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { APP_NAME, LIMITS, PROTOCOL_VERSION } from '../shared/constants'
import type { NetAddress } from '../shared/net'
import { loadOrCreateTls } from './cert'
import { configFromArgv, normalizeConfig, type ParentToServer, type ServerConfig, type ServerToParent } from './config'
import { ZvonDb } from './db'
import { Hub } from './hub'
import { listAddresses } from './interfaces'
import { FileService } from './files'
import { SfuService } from './sfu'
import { createLogger, type Logger } from './logger'

interface ParentPortLike {
  on(event: 'message', listener: (e: { data: unknown }) => void): void
  postMessage(message: unknown): void
}

export interface RunningServer {
  port: number
  fingerprint: string
  addresses: NetAddress[]
  rtcPort: number
  voiceError: string | null
  stop(reason?: string): Promise<void>
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  })
  res.end(payload)
}

function makeRequestHandler(cfg: ServerConfig, hub: () => Hub | null, files: FileService, log: Logger) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    try {
      const url = new URL(req.url ?? '/', 'https://zvon.local')
      if (files.handle(req, res, url)) return
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        })
        res.end()
        return
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, {
          app: APP_NAME.toLowerCase(),
          name: cfg.serverName,
          version: cfg.version,
          protocol: PROTOCOL_VERSION,
          requiresPassword: cfg.password.length > 0,
          voice: hub()?.voiceAvailable ?? false,
          online: hub()?.onlineCount ?? 0
        })
        return
      }
      sendJson(res, 404, { error: 'not_found' })
    } catch (err) {
      log.error('Ошибка HTTP-обработчика', err)
      if (!res.headersSent) sendJson(res, 500, { error: 'internal' })
      else res.destroy()
    }
  }
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.off('listening', onListening)
      if (err.code === 'EADDRINUSE') reject(new Error(`Порт ${port} уже занят другой программой. Выберите другой порт.`))
      else if (err.code === 'EACCES') reject(new Error(`Нет прав открыть порт ${port}. Выберите порт больше 1024.`))
      else if (err.code === 'EADDRNOTAVAIL') reject(new Error(`Адрес ${host} недоступен на этом компьютере.`))
      else reject(err)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

export async function startServer(
  rawConfig: Partial<ServerConfig> & { dataDir: string },
  onOnlineChange: (count: number) => void = () => {},
  onSettingsChanged: (maxUploadMb: number) => void = () => {}
): Promise<RunningServer> {
  const cfg = normalizeConfig(rawConfig)
  mkdirSync(cfg.dataDir, { recursive: true })
  const log = createLogger('server', join(cfg.dataDir, 'logs', 'server.log'))
  log.info(`Запуск сервера «${cfg.serverName}» на ${cfg.bindAddress}:${cfg.port}, пароль ${cfg.password ? 'задан' : 'не задан'}`)

  const db = new ZvonDb(join(cfg.dataDir, 'zvon.db'), log.child('db'))
  const sfu = new SfuService(cfg, log.child('sfu'))
  const files = new FileService(db, cfg, log.child('files'))
  files.start()
  let hub: Hub | null = null
  let https: Server | null = null
  try {
    // Ошибка SFU не мешает чату: сервер стартует, а голос сообщает причину.
    await sfu.start()
    const tls = loadOrCreateTls(cfg.dataDir, log.child('tls'))
    https = createServer({ key: tls.key, cert: tls.cert }, makeRequestHandler(cfg, () => hub, files, log.child('http')))
    https.on('clientError', (err, socket) => {
      log.debug('Ошибка TLS-клиента', (err as Error).message)
      socket.destroy()
    })
    const wss = new WebSocketServer({ server: https, path: '/ws', maxPayload: LIMITS.wsMaxPayload })
    wss.on('error', (err) => log.error('Ошибка WebSocket-сервера', err))
    hub = new Hub(wss, db, cfg, sfu, files, log.child('hub'), onOnlineChange)
    hub.onSettingsChanged = (s) => onSettingsChanged(s.maxUploadMb)
    hub.start()

    await listen(https, cfg.port, cfg.bindAddress)
    const addresses = listAddresses(false)
    log.info(
      `Сервер слушает порт ${cfg.port}. Адреса для друзей: ${addresses.map((a) => `${a.address} (${a.kind})`).join(', ') || 'нет'}`
    )

    const server = https
    let stopped = false
    return {
      port: cfg.port,
      fingerprint: tls.fingerprint,
      addresses,
      rtcPort: cfg.rtcPort,
      get voiceError() {
        return sfu.error
      },
      stop: async (reason = 'Хост остановил сервер') => {
        if (stopped) return
        stopped = true
        log.info(`Остановка сервера: ${reason}`)
        hub?.shutdown(reason)
        await new Promise<void>((resolve) => {
          // Даём клиентам получить server-closing и закрыть сокеты.
          setTimeout(() => {
            wss.close()
            server.close(() => resolve())
            server.closeAllConnections?.()
            setTimeout(resolve, 1500)
          }, 300)
        })
        sfu.close()
        files.stop()
        db.close()
        log.info('Сервер остановлен')
      }
    }
  } catch (err) {
    log.error('Не удалось запустить сервер', err)
    try {
      https?.close()
    } catch {
      /* ignore */
    }
    sfu.close()
    files.stop()
    db.close()
    throw err
  }
}

/* ======================= точка входа процесса ======================= */

function bootstrap(): void {
  const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort
  let running: RunningServer | null = null

  const post = (msg: ServerToParent): void => {
    if (parentPort) parentPort.postMessage(msg)
  }

  process.on('uncaughtException', (err) => {
    console.error('Необработанное исключение в сервере:', err)
    post({ type: 'fatal', message: err.message })
  })
  process.on('unhandledRejection', (reason) => {
    console.error('Необработанный отказ промиса в сервере:', reason)
  })

  if (parentPort) {
    parentPort.on('message', (e) => {
      const msg = e.data as ParentToServer
      if (msg?.type === 'start') {
        if (running) return
        startServer(
          msg.config,
          (count) => post({ type: 'online', count }),
          (maxUploadMb) => post({ type: 'settings', maxUploadMb })
        )
          .then((srv) => {
            running = srv
            post({
              type: 'ready',
              port: srv.port,
              fingerprint: srv.fingerprint,
              addresses: srv.addresses,
              rtcPort: srv.rtcPort,
              voiceError: srv.voiceError
            })
          })
          .catch((err: Error) => {
            post({ type: 'fatal', message: err.message })
            setTimeout(() => process.exit(1), 100)
          })
      } else if (msg?.type === 'stop') {
        const done = (): void => {
          post({ type: 'stopped' })
          setTimeout(() => process.exit(0), 100)
        }
        if (running) running.stop(msg.reason).then(done, done)
        else done()
      }
    })
    return
  }

  // Запуск без Electron UI.
  const argCfg = configFromArgv(process.argv.slice(2))
  if (!argCfg) {
    console.error('Использование: server.js --data <каталог> [--port 7777] [--password пароль] [--name "Имя"] [--bind 0.0.0.0] [--rtc-port 40000] [--rtc-ips 26.1.2.3,192.168.1.5] [--max-upload-mb 500]')
    process.exit(2)
  }
  startServer({ ...argCfg, adminToken: argCfg.adminToken ?? '', version: process.env.ZVON_VERSION })
    .then((srv) => {
      running = srv
      // Строка для автотестов и скриптов — не менять формат.
      console.log(
        `ZVON_READY ${JSON.stringify({ port: srv.port, fingerprint: srv.fingerprint, rtcPort: srv.rtcPort, voiceError: srv.voiceError })}`
      )
      const shutdown = (): void => {
        srv.stop('Сервер остановлен').finally(() => process.exit(0))
      }
      process.once('SIGINT', shutdown)
      process.once('SIGTERM', shutdown)
    })
    .catch((err: Error) => {
      console.error(`Ошибка запуска: ${err.message}`)
      process.exit(1)
    })
}

bootstrap()
