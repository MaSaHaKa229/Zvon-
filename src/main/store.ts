/**
 * Настройки приложения в JSON-файле внутри userData.
 * Запись атомарная (временный файл + rename), чтобы файл не бился при сбоях.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_PORT, DEFAULT_RTC_PORT, LIMITS } from '../shared/constants'
import type { AppSettings, HostSettings, RecentServer, TrustedCert } from '../preload/api'
import type { Logger } from '../server/logger'

export interface Settings {
  clientId: string
  nickname: string
  /** Токен администратора для собственного сервера хоста. */
  adminToken: string
  recentServers: RecentServer[]
  trustedCerts: TrustedCert[]
  host: HostSettings
  app: AppSettings
}

const MAX_RECENT = 12

function defaults(): Settings {
  return {
    clientId: randomUUID(),
    nickname: '',
    adminToken: randomBytes(24).toString('hex'),
    recentServers: [],
    trustedCerts: [],
    host: {
      port: DEFAULT_PORT,
      password: '',
      serverName: 'Сервер друзей',
      rtcPort: DEFAULT_RTC_PORT,
      maxUploadMb: LIMITS.defaultMaxUploadMb
    },
    app: { closeToTray: true, autostart: false, startMinimized: true }
  }
}

export class SettingsStore {
  private file: string
  private data: Settings

  constructor(userDataDir: string, private log: Logger) {
    this.file = join(userDataDir, 'settings.json')
    this.data = this.load()
  }

  private load(): Settings {
    const base = defaults()
    if (!existsSync(this.file)) {
      this.persist(base)
      return base
    }
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Settings>
      const merged: Settings = {
        clientId: typeof raw.clientId === 'string' && raw.clientId.length >= 8 ? raw.clientId : base.clientId,
        nickname: typeof raw.nickname === 'string' ? raw.nickname.slice(0, LIMITS.nicknameLength) : '',
        adminToken: typeof raw.adminToken === 'string' && raw.adminToken.length >= 16 ? raw.adminToken : base.adminToken,
        recentServers: Array.isArray(raw.recentServers) ? raw.recentServers.filter((r) => r && typeof r.host === 'string') : [],
        trustedCerts: Array.isArray(raw.trustedCerts) ? raw.trustedCerts.filter((c) => c && typeof c.fingerprint === 'string') : [],
        host: { ...base.host, ...(raw.host ?? {}) },
        app: { ...base.app, ...(raw.app ?? {}) }
      }
      if (merged.clientId !== raw.clientId || merged.adminToken !== raw.adminToken) this.persist(merged)
      return merged
    } catch (err) {
      this.log.error('settings.json повреждён, создаю заново (старый сохранён как settings.broken.json)', err)
      try {
        renameSync(this.file, join(this.file, '..', 'settings.broken.json'))
      } catch {
        /* ignore */
      }
      this.persist(base)
      return base
    }
  }

  private persist(data: Settings): void {
    const tmp = this.file + '.tmp'
    try {
      writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
      renameSync(tmp, this.file)
    } catch (err) {
      this.log.error('Не удалось сохранить настройки', err)
    }
  }

  get(): Readonly<Settings> {
    return this.data
  }

  update(patch: Partial<Settings>): Settings {
    this.data = { ...this.data, ...patch }
    this.persist(this.data)
    return this.data
  }

  setNickname(nickname: string): void {
    this.update({ nickname: nickname.trim().slice(0, LIMITS.nicknameLength) })
  }

  setHostSettings(host: HostSettings): void {
    this.update({ host })
  }

  rememberServer(host: string, port: number, name: string, password?: string, adminToken?: string): RecentServer[] {
    const rest = this.data.recentServers.filter((r) => !(r.host === host && r.port === port))
    const entry: RecentServer = { host, port, name, lastUsed: Date.now() }
    if (password) entry.password = password
    if (adminToken) entry.adminToken = adminToken
    const recentServers = [entry, ...rest].slice(0, MAX_RECENT)
    this.update({ recentServers })
    return recentServers
  }

  forgetServer(host: string, port: number): RecentServer[] {
    const recentServers = this.data.recentServers.filter((r) => !(r.host === host && r.port === port))
    this.update({ recentServers })
    return recentServers
  }

  trustState(host: string, port: number, fingerprint: string): 'trusted' | 'new' | 'changed' {
    const entry = this.data.trustedCerts.find((c) => c.host === host && c.port === port)
    if (!entry) return 'new'
    return entry.fingerprint === fingerprint ? 'trusted' : 'changed'
  }

  trust(host: string, port: number, fingerprint: string): void {
    const rest = this.data.trustedCerts.filter((c) => !(c.host === host && c.port === port))
    this.update({ trustedCerts: [...rest, { host, port, fingerprint, addedAt: Date.now() }] })
  }

  /** Для проверки сертификата в Chromium: порт там неизвестен, поэтому сверяем хост и отпечаток. */
  isTrustedFingerprint(host: string, fingerprint: string): boolean {
    return this.data.trustedCerts.some((c) => c.host === host && c.fingerprint === fingerprint)
  }
}
