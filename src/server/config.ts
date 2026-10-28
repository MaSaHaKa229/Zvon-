import { DEFAULT_PORT, DEFAULT_RTC_PORT, LIMITS } from '../shared/constants'

/** Конфигурация, с которой запускается сервер хоста. */
export interface ServerConfig {
  port: number
  /** Адрес для прослушивания. 0.0.0.0 — все интерфейсы (LAN + все VPN). */
  bindAddress: string
  serverName: string
  /** Пустой пароль — вход без пароля. */
  password: string
  /** Токен, дающий права администратора (знает только приложение хоста). */
  adminToken: string
  /** Каталог для базы, сертификата и логов. */
  dataDir: string
  /** Версия приложения хоста (показывается клиентам). */
  version: string
  /** Порт медиа (UDP+TCP) для голоса и видео. */
  rtcPort: number
  /** IPv4-адреса, на которых слушает медиа. Пусто — все подходящие адреса автоматически. */
  rtcIps: string[]
  /** Максимальный размер одного файла, МБ. */
  maxUploadMb: number
}

/** Сообщения main → сервер (через parentPort). */
export type ParentToServer = { type: 'start'; config: ServerConfig } | { type: 'stop'; reason?: string }

/** Сообщения сервер → main. */
export type ServerToParent =
  | {
      type: 'ready'
      port: number
      fingerprint: string
      addresses: import('../shared/net').NetAddress[]
      rtcPort: number
      /** null — голос работает, иначе причина недоступности. */
      voiceError: string | null
    }
  | { type: 'fatal'; message: string }
  | { type: 'stopped' }
  | { type: 'online'; count: number }
  /** Хост изменил лимит файла в панели — main сохранит его в настройках запуска. */
  | { type: 'settings'; maxUploadMb: number }

export function normalizeConfig(input: Partial<ServerConfig> & { dataDir: string }): ServerConfig {
  const port = Number(input.port ?? DEFAULT_PORT)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Неверный порт: ${input.port}`)
  }
  const serverName = (input.serverName ?? '').trim().slice(0, LIMITS.serverNameLength) || 'Сервер Zvon'
  const password = (input.password ?? '').slice(0, LIMITS.passwordLength)
  const rtcPort = Number(input.rtcPort ?? DEFAULT_RTC_PORT)
  if (!Number.isInteger(rtcPort) || rtcPort < 1024 || rtcPort > 65535) {
    throw new Error(`Неверный порт медиа: ${input.rtcPort}`)
  }
  if (rtcPort === port) throw new Error('Порт медиа должен отличаться от порта сервера')
  const maxUploadMb = Math.round(Number(input.maxUploadMb ?? LIMITS.defaultMaxUploadMb))
  if (!Number.isFinite(maxUploadMb) || maxUploadMb < 1 || maxUploadMb > 10240) {
    throw new Error(`Лимит файла должен быть от 1 до 10240 МБ: ${input.maxUploadMb}`)
  }
  return {
    port,
    bindAddress: input.bindAddress?.trim() || '0.0.0.0',
    serverName,
    password,
    adminToken: input.adminToken ?? '',
    dataDir: input.dataDir,
    version: input.version || '0.0.0',
    rtcPort,
    maxUploadMb,
    rtcIps: (input.rtcIps ?? []).filter((ip) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip))
  }
}

/** Разбор аргументов для запуска без UI: `--port 7777 --password x --name "..." --data ./dir`. */
export function configFromArgv(argv: string[]): (Partial<ServerConfig> & { dataDir: string }) | null {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    if (i >= 0 && i + 1 < argv.length) return argv[i + 1]
    const pref = argv.find((a) => a.startsWith(flag + '='))
    return pref ? pref.slice(flag.length + 1) : undefined
  }
  const dataDir = get('--data')
  if (!dataDir) return null
  return {
    dataDir,
    port: get('--port') ? Number(get('--port')) : undefined,
    password: get('--password'),
    serverName: get('--name'),
    bindAddress: get('--bind'),
    rtcPort: get('--rtc-port') ? Number(get('--rtc-port')) : undefined,
    maxUploadMb: get('--max-upload-mb') ? Number(get('--max-upload-mb')) : undefined,
    rtcIps: get('--rtc-ips')?.split(',').map((s) => s.trim()).filter(Boolean),
    adminToken: get('--admin-token')
  }
}
