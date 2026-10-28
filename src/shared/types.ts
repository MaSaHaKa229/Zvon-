import type { ErrorCode } from './constants'

export type ChannelType = 'text' | 'voice'

export interface Channel {
  id: string
  name: string
  type: ChannelType
  position: number
}

export interface UserInfo {
  id: string
  nickname: string
  /** id файла аватарки на хосте (null — буквенная аватарка). */
  avatar: string | null
  online: boolean
  isAdmin: boolean
}

export type FileKind = 'image' | 'video' | 'audio' | 'file' | 'avatar'

/** Файл, хранящийся на хосте. */
export interface FileInfo {
  id: string
  name: string
  mime: string
  size: number
  kind: FileKind
  width: number | null
  height: number | null
  /** Длительность видео/аудио в секундах. */
  duration: number | null
  /** Миниатюра (для фото и видео), сгенерированная клиентом при загрузке. */
  thumbId: string | null
}

export interface Message {
  /** Монотонный id — по нему же идёт пагинация истории. */
  id: number
  channelId: string
  authorId: string
  /** Ник автора на момент отправки (на случай, если пользователь больше не известен). */
  authorName: string
  content: string
  /** id упомянутых пользователей; 'everyone' — упоминание всех. */
  mentions: string[]
  attachments: FileInfo[]
  createdAt: number
  editedAt: number | null
  /** Эхо клиентского nonce — чтобы отправитель сопоставил своё сообщение. */
  nonce?: string
}

/* ---------------- Голос и медиа ---------------- */

/** Непрозрачные структуры mediasoup (rtpParameters, dtlsParameters и т. п.) передаются как есть. */
export type MediaJson = Record<string, unknown>

export type MediaKind = 'audio' | 'video'
/** Источник потока: микрофон, камера, демонстрация экрана и её звук. */
export type MediaSource = 'mic' | 'camera' | 'screen' | 'screen-audio'

export interface VoiceState {
  userId: string
  channelId: string
  muted: boolean
  deafened: boolean
  joinedAt: number
}

export interface ProducerInfo {
  producerId: string
  userId: string
  channelId: string
  kind: MediaKind
  source: MediaSource
  paused: boolean
}

export interface TransportInfo {
  id: string
  iceParameters: MediaJson
  iceCandidates: MediaJson[]
  dtlsParameters: MediaJson
}

export interface ConsumerInfo {
  consumerId: string
  producerId: string
  userId: string
  kind: MediaKind
  source: MediaSource
  rtpParameters: MediaJson
  producerPaused: boolean
  /** Сколько пространственных/временных слоёв у потока (1 — без simulcast/SVC). */
  spatialLayers: number
  temporalLayers: number
}

/* ---------------- Панель хоста ---------------- */

/** Настройки сервера, меняющиеся на лету (хранятся в БД хоста). */
export interface AdminSettings {
  /** Максимум входящего потока от одного клиента, кбит/с. */
  maxIncomingKbps: number
  /** Максимум исходящего потока к одному клиенту, кбит/с (0 — без ограничения). */
  maxOutgoingKbps: number
  maxUploadMb: number
}

export interface AdminUserStats {
  userId: string
  nickname: string
  ip: string
  isAdmin: boolean
  voiceChannelId: string | null
  /** Хост → клиент, кбит/с. */
  sendKbps: number
  /** Клиент → хост, кбит/с. */
  recvKbps: number
  producers: number
  consumers: number
  connectedAt: number
}

export interface AdminStats {
  uptimeSec: number
  memoryMb: number
  users: AdminUserStats[]
  sfu: {
    available: boolean
    error: string | null
    cpuPercent: number
    rooms: number
    producers: number
    consumers: number
    sendKbps: number
    recvKbps: number
    rtcPort: number
    listenIps: string[]
  }
  files: { totalBytes: number }
  settings: AdminSettings
  banned: Array<{ userId: string; nickname: string }>
}

export interface ServerSnapshot {
  serverName: string
  serverVersion: string
  channels: Channel[]
  users: UserInfo[]
  you: UserInfo
  voiceStates: VoiceState[]
  /** null — голос работает; иначе причина, почему SFU недоступен. */
  voiceError: string | null
  /** Токен для HTTP-запросов к файлам (?t= или Authorization: Bearer). */
  fileToken: string
  maxUploadBytes: number
}

/* ---------------- Запросы клиент → сервер и ответы на них ---------------- */

export interface RequestMap {
  hello: {
    protocol: number
    clientId: string
    nickname: string
    password: string
    adminToken?: string
  }
  ping: Record<string, never>
  'msg-send': { channelId: string; content: string; nonce?: string; attachments?: string[] }
  'msg-edit': { messageId: number; content: string }
  'msg-delete': { messageId: number }
  'msg-history': { channelId: string; before?: number; limit?: number }
  /** avatar: id загруженного файла, null — убрать аватарку, не указан — не менять. */
  'profile-update': { nickname: string; avatar?: string | null }
  typing: { channelId: string }

  'voice-join': { channelId: string }
  'voice-ready': { rtpCapabilities: MediaJson }
  'voice-leave': Record<string, never>
  'voice-state-update': { muted: boolean; deafened: boolean }
  'transport-create': { direction: 'send' | 'recv' }
  'transport-connect': { transportId: string; dtlsParameters: MediaJson }
  'transport-restart-ice': { transportId: string }
  produce: { transportId: string; kind: MediaKind; rtpParameters: MediaJson; source: MediaSource; paused?: boolean }
  'producer-close': { producerId: string }
  'producer-pause': { producerId: string }
  'producer-resume': { producerId: string }
  consume: { producerId: string }
  'consumer-resume': { consumerId: string }
  'consumer-pause': { consumerId: string }
  'consumer-set-layers': { consumerId: string; spatialLayer: number; temporalLayer?: number }

  /* только для администратора (хоста) */
  'admin-stats': Record<string, never>
  'admin-settings': Partial<AdminSettings>
  'admin-kick': { userId: string; ban: boolean }
  'admin-unban': { userId: string }
  'channel-create': { name: string; type: ChannelType }
  'channel-rename': { channelId: string; name: string }
  'channel-delete': { channelId: string }
  'channel-move': { channelId: string; direction: 'up' | 'down' }
}

export interface ResponseMap {
  hello: ServerSnapshot
  ping: { time: number }
  'msg-send': { message: Message }
  'msg-edit': { message: Message }
  'msg-delete': { messageId: number }
  'msg-history': { channelId: string; messages: Message[]; hasMore: boolean }
  'profile-update': { user: UserInfo }
  typing: Record<string, never>

  'voice-join': { channelId: string; routerRtpCapabilities: MediaJson }
  'voice-ready': { producers: ProducerInfo[] }
  'voice-leave': Record<string, never>
  'voice-state-update': { state: VoiceState }
  'transport-create': TransportInfo
  'transport-connect': Record<string, never>
  'transport-restart-ice': { iceParameters: MediaJson }
  produce: { producerId: string }
  'producer-close': Record<string, never>
  'producer-pause': Record<string, never>
  'producer-resume': Record<string, never>
  consume: ConsumerInfo
  'consumer-resume': Record<string, never>
  'consumer-pause': Record<string, never>
  'consumer-set-layers': Record<string, never>

  'admin-stats': AdminStats
  'admin-settings': { settings: AdminSettings }
  'admin-kick': Record<string, never>
  'admin-unban': Record<string, never>
  'channel-create': { channel: Channel }
  'channel-rename': { channel: Channel }
  'channel-delete': Record<string, never>
  'channel-move': Record<string, never>
}

export type RequestType = keyof RequestMap

/* ---------------- События сервер → клиент ---------------- */

export interface EventMap {
  'msg-new': { message: Message }
  'msg-updated': { message: Message }
  'msg-deleted': { messageId: number; channelId: string }
  typing: { channelId: string; userId: string }
  'user-joined': { user: UserInfo }
  'user-left': { userId: string }
  'user-updated': { user: UserInfo }
  'channels-updated': { channels: Channel[] }
  'server-closing': { reason: string }

  /** state = null — пользователь вышел из голоса. */
  'voice-state': { userId: string; state: VoiceState | null }
  'new-producer': ProducerInfo
  'producer-closed': { producerId: string; userId: string }
  'consumer-closed': { consumerId: string; producerId: string }
  /** Кто сейчас говорит: userId → громкость в dBov (−127…0). Пустой объект — тишина. */
  speaking: { channelId: string; levels: Record<string, number> }
  'active-speaker': { channelId: string; userId: string | null }
  /** Какой слой качества сейчас реально приходит (null — ничего, например при паузе). */
  'consumer-layers': { consumerId: string; spatialLayer: number | null; temporalLayer: number | null }
  /** Хост изменил настройки, важные клиентам. */
  'server-settings': { maxUploadBytes: number }
  /** SFU перезапущен — клиенты в голосе должны переподключиться. */
  'voice-reset': { reason: string }
}

export type EventType = keyof EventMap

/* ---------------- Конверты ---------------- */

export interface ClientEnvelope {
  t: string
  id?: number
  d?: unknown
}

export interface ErrorPayload {
  code: ErrorCode
  message: string
}

export type ServerEnvelope =
  | { t: 'res'; id: number; ok: true; d: unknown }
  | { t: 'res'; id: number; ok: false; err: ErrorPayload }
  | { t: EventType; d: unknown }
