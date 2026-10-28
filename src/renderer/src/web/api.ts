/**
 * Реализация window.zvon для веб-версии (браузер на компьютере или телефоне).
 * В Electron эти функции даёт preload; здесь — средства браузера и localStorage.
 * Сервер всегда один — тот, с которого открыта страница.
 */
import type { AppSettings, HostStatus, InitialState, ProbeResult, RecentServer, ServerHealth, ZvonApi } from '../../../preload/api'
import { DEFAULT_PORT, DEFAULT_RTC_PORT, LIMITS } from '../../../shared/constants'

const KEY = 'zvon:web'

interface WebStore {
  clientId: string
  nickname: string
  recentServers: RecentServer[]
}

function load(): WebStore {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<WebStore> | null
    if (raw && typeof raw.clientId === 'string') {
      return { clientId: raw.clientId, nickname: raw.nickname ?? '', recentServers: Array.isArray(raw.recentServers) ? raw.recentServers : [] }
    }
  } catch {
    // повреждённые данные — начинаем заново
  }
  return { clientId: crypto.randomUUID(), nickname: '', recentServers: [] }
}

// Читается в installWebApi: в десктоп-сборке модуль подключён, но не должен трогать localStorage.
let store: WebStore = { clientId: '', nickname: '', recentServers: [] }

function save(patch: Partial<WebStore>): void {
  store = { ...store, ...patch }
  try {
    localStorage.setItem(KEY, JSON.stringify(store))
  } catch {
    // приватный режим — работаем без сохранения
  }
}

const STOPPED: HostStatus = {
  state: 'stopped',
  port: null,
  fingerprint: null,
  addresses: [],
  online: 0,
  error: null,
  rtcPort: null,
  voiceError: null
}

const APP_SETTINGS: AppSettings = { closeToTray: false, autostart: false, startMinimized: false }

const noop = (): (() => void) => () => undefined

const unsupported = (): Promise<never> => Promise.reject(new Error('Недоступно в веб-версии'))

/** Значок в заголовке вкладки вместо трея: «(3) Zvon». */
function setTitleBadge(unread: number, mentions: number): void {
  const n = mentions || unread
  document.title = n > 0 ? `(${n}) Zvon` : 'Zvon'
}

export const webApi: ZvonApi = {
  async getInitialState(): Promise<InitialState> {
    return {
      clientId: store.clientId,
      nickname: store.nickname,
      adminToken: '',
      recentServers: store.recentServers,
      hostSettings: { port: DEFAULT_PORT, password: '', serverName: '', rtcPort: DEFAULT_RTC_PORT, maxUploadMb: LIMITS.defaultMaxUploadMb },
      hostStatus: STOPPED,
      platform: 'web',
      version: __ZVON_VERSION__,
      profile: null,
      // Браузер сам предлагает «поделиться звуком» в своём окне выбора экрана.
      systemAudio: 'loopback',
      appSettings: APP_SETTINGS,
      trayAvailable: false
    }
  },
  async setNickname(nickname) {
    save({ nickname })
  },
  async probeServer(): Promise<ProbeResult> {
    // Сертификат проверяет браузер (HTTPS), отпечаток сверять не нужно.
    try {
      const res = await fetch('/health', { cache: 'no-store' })
      if (!res.ok) return { ok: false, error: `Сервер ответил ошибкой ${res.status}` }
      const health = (await res.json()) as ServerHealth
      return { ok: true, fingerprint: '', trust: 'trusted', health }
    } catch {
      return { ok: false, error: 'Сервер не отвечает. Проверьте интернет и обновите страницу.' }
    }
  },
  async trustServer() {},
  async rememberServer(host, port, name, password, adminToken) {
    const entry: RecentServer = { host, port, name, lastUsed: Date.now() }
    if (password) entry.password = password
    if (adminToken) entry.adminToken = adminToken
    save({ recentServers: [entry] })
    return store.recentServers
  },
  async forgetServer() {
    save({ recentServers: [] })
    return []
  },
  startHost: unsupported,
  stopHost: unsupported,
  onHostStatus: noop,
  async openExternal(url) {
    window.open(url, '_blank', 'noopener,noreferrer')
  },
  async copyText(text) {
    await navigator.clipboard.writeText(text)
  },
  // Разрешение на микрофон и камеру браузер спрашивает сам при первом обращении.
  async ensureMediaAccess() {
    return true
  },
  async pttSupport() {
    return { global: false, reason: 'В браузере клавиша работает, только пока открыта вкладка Zvon.' }
  },
  async pttConfigure() {},
  async pttRecord() {
    return null
  },
  onPttChange: noop,
  // Окно выбора экрана, окна или вкладки показывает сам браузер.
  async screenSources() {
    return [{ id: 'browser', name: 'Выбор в браузере', kind: 'screen' as const, thumbnail: null, icon: null }]
  },
  async screenSelect() {},
  async screenAccess() {
    return 'granted' as const
  },
  async openScreenSettings() {},
  async downloadFile(url) {
    const a = document.createElement('a')
    a.href = url
    a.download = ''
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
  },
  async setAppSettings() {
    return APP_SETTINGS
  },
  setTrayState(state) {
    setTitleBadge(state.unread, state.mentions)
  },
  onTrayAction: noop,
  focusWindow() {
    window.focus()
  },
  requestAttention() {},
  async firewallCheck() {
    return { supported: false, missing: [] }
  },
  firewallAdd: unsupported
}

export function installWebApi(): void {
  store = load()
  save({})
  window.zvon = webApi
}
