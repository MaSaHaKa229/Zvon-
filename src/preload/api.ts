/**
 * Контракт между renderer и main. Файл содержит только типы, поэтому его
 * безопасно импортировать и из renderer, и из main.
 */
import type { NetAddress } from '../shared/net'

export interface RecentServer {
  host: string
  port: number
  name: string
  lastUsed: number
  /** Пароль сохраняется только если пользователь поставил галочку «Запомнить пароль». */
  password?: string
}

export interface TrustedCert {
  host: string
  port: number
  fingerprint: string
  addedAt: number
}

export interface HostSettings {
  port: number
  password: string
  serverName: string
  /** Порт медиа (UDP+TCP) для голоса и видео. */
  rtcPort: number
  /** Максимальный размер одного файла, МБ. */
  maxUploadMb: number
}

/** Клавиша push-to-talk: глобальная (uiohook) или только в окне (DOM KeyboardEvent.code). */
export type PttBinding =
  | { type: 'key' | 'mouse'; code: number; label: string }
  | { type: 'dom'; code: string; label: string }

export interface PttSupport {
  global: boolean
  /** Предупреждение для пользователя (например, нужен доступ в macOS). */
  reason?: string
}

export type HostState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'

export interface HostStatus {
  state: HostState
  port: number | null
  fingerprint: string | null
  addresses: NetAddress[]
  online: number
  error: string | null
  rtcPort: number | null
  /** null — голос работает; иначе причина недоступности медиасервера. */
  voiceError: string | null
}

export interface ServerHealth {
  app: string
  name: string
  version: string
  protocol: number
  requiresPassword: boolean
  online: number
  voice: boolean
}

export type ProbeResult =
  | { ok: true; fingerprint: string; trust: 'trusted' | 'new' | 'changed'; health: ServerHealth }
  | { ok: false; error: string }

export interface ScreenSource {
  id: string
  name: string
  kind: 'screen' | 'window'
  /** Превью в data:URL (может отсутствовать, например на Wayland). */
  thumbnail: string | null
  icon: string | null
}

export type ScreenAccess = 'granted' | 'denied' | 'unknown'

/**
 * Как можно захватить звук системы при демонстрации:
 * loopback — средствами ОС (Windows, macOS 13+); monitor — через «Monitor»-устройство PulseAudio/PipeWire (Linux); none — нельзя.
 */
export type SystemAudioMode = 'loopback' | 'monitor' | 'none'

/** Настройки приложения (не сервера): трей и автозапуск. */
export interface AppSettings {
  /** Крестик окна сворачивает в трей, а не закрывает приложение. */
  closeToTray: boolean
  autostart: boolean
  /** При автозапуске не показывать окно, только значок в трее. */
  startMinimized: boolean
}

export interface TrayState {
  inVoice: boolean
  voiceChannel: string | null
  muted: boolean
  deafened: boolean
  unread: number
  mentions: number
}

export type TrayAction = 'toggle-mute' | 'toggle-deafen' | 'leave-voice'

export interface FirewallStatus {
  /** false — не Windows, проверка не нужна. */
  supported: boolean
  /** Каких правил не хватает, например «TCP 7777». */
  missing: string[]
  error?: string
}

export interface InitialState {
  clientId: string
  nickname: string
  /** Админ-токен своего сервера (используется только при подключении к себе). */
  adminToken: string
  recentServers: RecentServer[]
  hostSettings: HostSettings
  hostStatus: HostStatus
  platform: string
  version: string
  profile: string | null
  systemAudio: SystemAudioMode
  appSettings: AppSettings
  trayAvailable: boolean
}

export interface ZvonApi {
  getInitialState(): Promise<InitialState>
  setNickname(nickname: string): Promise<void>
  probeServer(host: string, port: number): Promise<ProbeResult>
  trustServer(host: string, port: number, fingerprint: string): Promise<void>
  rememberServer(host: string, port: number, name: string, password?: string): Promise<RecentServer[]>
  forgetServer(host: string, port: number): Promise<RecentServer[]>
  startHost(settings: HostSettings): Promise<HostStatus>
  stopHost(): Promise<HostStatus>
  onHostStatus(listener: (status: HostStatus) => void): () => void
  openExternal(url: string): Promise<void>
  copyText(text: string): Promise<void>
  /** macOS: запрашивает системное разрешение; на других ОС всегда true. */
  ensureMediaAccess(kind: 'microphone' | 'camera'): Promise<boolean>
  pttSupport(): Promise<PttSupport>
  pttConfigure(enabled: boolean, binding: PttBinding | null): Promise<void>
  /** Ждёт нажатия глобальной клавиши (null — отмена или недоступно). */
  pttRecord(): Promise<PttBinding | null>
  onPttChange(listener: (pressed: boolean) => void): () => void
  screenSources(): Promise<ScreenSource[]>
  /** Запоминает выбор: следующий getDisplayMedia получит этот источник. */
  screenSelect(sourceId: string, audio: boolean): Promise<void>
  screenAccess(): Promise<ScreenAccess>
  openScreenSettings(): Promise<void>
  /** Скачать файл с хоста (покажет системный диалог сохранения). */
  downloadFile(url: string): Promise<void>
  setAppSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  setTrayState(state: TrayState): void
  onTrayAction(listener: (action: TrayAction) => void): () => void
  /** Показать и сфокусировать окно (например, по клику на уведомление). */
  focusWindow(): void
  /** Мигнуть кнопкой на панели задач, если окно не в фокусе. */
  requestAttention(): void
  firewallCheck(port: number, rtcPort: number): Promise<FirewallStatus>
  firewallAdd(port: number, rtcPort: number): Promise<FirewallStatus>
}
