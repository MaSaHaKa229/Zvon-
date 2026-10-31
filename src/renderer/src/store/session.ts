/**
 * Действия приложения: подключение к серверу, хост, чат.
 * Состояние — в zustand (store/app.ts), сетевой клиент — здесь.
 */
import i18n from '../i18n'
import { LIMITS, TIMINGS } from '../../../shared/constants'
import type { HostSettings } from '../../../preload/api'
import type { Channel, FileInfo, Message, RequestMap, RequestType, ResponseMap, ServerSnapshot, UserInfo } from '../../../shared/types'
import { dataUrlToBlob, uploadBlob } from '../lib/files'
import { clearAllDrafts } from './uploads'
import { notifyIncoming } from '../lib/notify'
import { initTraySync } from './tray'
import { ServerError, ZvonClient } from '../net/client'
import { getApp, initialServerState, mergeMessages, patchChannel, setApp, type ConnTarget, type PendingMessage } from './app'
import { attachVoice, detachVoice, initVoiceGlobal, leaveVoice, onConnStatusForVoice, onVoiceWelcome } from './voice'

let client: ZvonClient | null = null
let lastTypingSent = 0
const unsubscribers: Array<() => void> = []

const t = (key: string, opts?: Record<string, unknown>): string => i18n.t(key, opts)

/** Ошибки IPC приходят с префиксом «Error invoking remote method …: Error: ». */
export function cleanError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

function randomNonce(): string {
  const a = new Uint32Array(2)
  crypto.getRandomValues(a)
  return `${Date.now().toString(36)}-${a[0].toString(36)}${a[1].toString(36)}`
}

/* ======================= запуск приложения ======================= */

let bootStarted = false

export async function bootApp(): Promise<void> {
  // StrictMode в режиме разработки вызывает эффекты дважды — подписываемся один раз.
  if (bootStarted) return
  bootStarted = true
  const boot = await window.zvon.getInitialState()
  setApp({ boot, nickname: boot.nickname, recentServers: boot.recentServers, hostStatus: boot.hostStatus })
  window.zvon.onHostStatus((hostStatus) => setApp({ hostStatus }))
  void initVoiceGlobal()
  initTraySync()
  window.addEventListener('focus', () => {
    setApp({ windowFocused: true })
    const ch = getApp().currentChannelId
    if (ch) clearUnread(ch)
  })
  window.addEventListener('blur', () => setApp({ windowFocused: false }))
}

export function setNicknameDraft(nickname: string): void {
  setApp({ nickname })
}

/* ======================= подключение ======================= */

/**
 * Шаг 1: проверка сервера и сертификата. Если сертификат новый или изменился,
 * показываем диалог доверия; иначе подключаемся сразу.
 */
export async function beginConnect(target: ConnTarget): Promise<void> {
  const nickname = getApp().nickname.trim()
  // С аккаунтом ник берётся с сервера.
  if (target.login !== undefined) {
    if (!target.login.trim() || !target.password) {
      setApp({ connectError: t('connect.errLogin') })
      return
    }
  } else if (!nickname) {
    setApp({ connectError: t('connect.errNickname') })
    return
  }
  setApp({ connecting: true, connectError: null })
  try {
    if (nickname) await window.zvon.setNickname(nickname)
    const probe = await window.zvon.probeServer(target.host, target.port)
    if (!probe.ok) {
      setApp({ connecting: false, connectError: probe.error })
      return
    }
    if (probe.trust !== 'trusted') {
      setApp({ connecting: false, trustPrompt: { target, probe } })
      return
    }
    await openSession(target, probe.health.name)
  } catch (err) {
    setApp({ connecting: false, connectError: cleanError(err) })
  }
}

/** Шаг 2 (после диалога): пользователь доверился сертификату. */
export async function acceptTrust(): Promise<void> {
  const prompt = getApp().trustPrompt
  if (!prompt) return
  setApp({ trustPrompt: null, connecting: true, connectError: null })
  try {
    await window.zvon.trustServer(prompt.target.host, prompt.target.port, prompt.probe.fingerprint)
    await openSession(prompt.target, prompt.probe.health.name)
  } catch (err) {
    setApp({ connecting: false, connectError: cleanError(err) })
  }
}

export function rejectTrust(): void {
  setApp({ trustPrompt: null, connecting: false })
}

/** Сервер текущей сессии — чтобы обновить сохранённый пароль после его смены. */
let sessionTarget: { target: ConnTarget; serverName: string } | null = null

async function openSession(target: ConnTarget, serverName: string): Promise<void> {
  disposeClient()
  sessionTarget = { target, serverName }
  const boot = getApp().boot!
  const hostStatus = getApp().hostStatus
  const isOwnServer = target.host === '127.0.0.1' && hostStatus.state === 'running' && hostStatus.port === target.port

  const c = new ZvonClient(
    {
      host: target.host,
      port: target.port,
      hello: {
        clientId: boot.clientId,
        nickname: getApp().nickname.trim() || target.login?.trim() || 'user',
        password: target.password,
        adminToken: isOwnServer ? boot.adminToken : target.adminToken || undefined,
        login: target.login?.trim() || undefined
      }
    },
    {
      onStatus: (connStatus, reconnectAttempt) => {
        setApp({ connStatus, reconnectAttempt })
        onConnStatusForVoice(connStatus)
      },
      onWelcome: (snapshot, isReconnect) => {
        applySnapshot(snapshot, isReconnect)
        onVoiceWelcome(snapshot, isReconnect)
      },
      onFatal: (message, code) => {
        const text =
          code === 'replaced' ? t('conn.replaced') : code === 'kicked' ? t('conn.kicked') : message || t('conn.authFailed')
        returnToConnect(text)
      }
    }
  )
  client = c
  wireEvents(c)
  attachVoice(c)
  setApp({ target, isOwnServer, connNotice: null })

  try {
    await c.connect()
  } catch (err) {
    if (client === c) disposeClient()
    const e = err as ServerError
    const message =
      e.code === 'handshake'
        ? t('conn.failedHandshake', { host: target.host, port: target.port })
        : e.code === 'auth_failed'
          ? t('conn.authFailed')
          : e.message
    setApp({ connecting: false, connectError: message })
    return
  }

  // Ник, который реально выдал сервер (мог добавить суффикс), сохраняем локально.
  const me = getApp().me
  const recentServers = await window.zvon.rememberServer(
    target.host,
    target.port,
    isOwnServer ? `${serverName} ${t('host.mine')}` : serverName,
    target.remember ? target.password : undefined,
    target.remember ? target.adminToken : undefined,
    target.login?.trim() || undefined
  )
  setApp({ connecting: false, recentServers, screen: 'main' })
  if (me) setNicknameDraft(me.nickname)
}

function applySnapshot(s: ServerSnapshot, isReconnect: boolean): void {
  const users: Record<string, UserInfo> = {}
  for (const u of s.users) users[u.id] = u
  users[s.you.id] = s.you
  const prev = getApp()
  const textChannels = s.channels.filter((c) => c.type === 'text')
  const currentStillExists = prev.currentChannelId && textChannels.some((c) => c.id === prev.currentChannelId)
  const currentChannelId = currentStillExists ? prev.currentChannelId : (textChannels[0]?.id ?? null)

  setApp({
    serverName: s.serverName,
    me: s.you,
    users,
    channels: s.channels,
    currentChannelId,
    connNotice: null,
    // После переподключения кэш истории сбрасываем: за время обрыва сообщения могли измениться.
    messages: isReconnect ? {} : prev.messages,
    typing: {},
    fileToken: s.fileToken,
    maxUploadBytes: s.maxUploadBytes,
    account: s.account ?? null
  })
  if (currentChannelId) void loadHistory(currentChannelId)
  if (isReconnect) retryFailedPending()
  // Своя аватарка хранится локально и сама появляется на новых серверах.
  // С аккаунтами аватарка хранится на сервере и одна на всех устройствах — локальную не подставляем.
  else if (!s.you.avatar && !s.account) void applyLocalAvatar()
}

const AVATAR_KEY = 'zvon.avatar'

export function localAvatar(): string | null {
  try {
    return localStorage.getItem(AVATAR_KEY)
  } catch {
    return null
  }
}

function setLocalAvatar(dataUrl: string | null): void {
  try {
    if (dataUrl) localStorage.setItem(AVATAR_KEY, dataUrl)
    else localStorage.removeItem(AVATAR_KEY)
  } catch {
    /* не страшно */
  }
}

async function applyLocalAvatar(): Promise<void> {
  const dataUrl = localAvatar()
  if (!dataUrl) return
  try {
    await uploadAndSetAvatar(await dataUrlToBlob(dataUrl))
  } catch (err) {
    console.warn('[zvon] не удалось установить сохранённую аватарку', err)
  }
}

async function uploadAndSetAvatar(blob: Blob): Promise<UserInfo> {
  if (!client) throw new Error(t('conn.lost'))
  const file = await uploadBlob(blob, { name: 'avatar.webp', type: blob.type || 'image/webp', purpose: 'avatar' }, () => undefined)
  const nickname = getApp().me?.nickname ?? getApp().nickname
  const { user } = await client.request('profile-update', { nickname, avatar: file.id })
  setApp((s) => ({ me: user, users: { ...s.users, [user.id]: user } }))
  return user
}

/** Смена пароля своего аккаунта. Возвращает текст ошибки или null. */
export async function changePassword(oldPassword: string, newPassword: string): Promise<string | null> {
  if (!client) return t('conn.lost')
  try {
    await client.request('password-change', { oldPassword, newPassword })
  } catch (err) {
    return err instanceof ServerError ? err.message : cleanError(err)
  }
  // Переподключение после обрыва должно идти уже с новым паролем.
  client.updateHello({ password: newPassword })
  if (sessionTarget) {
    const { target, serverName } = sessionTarget
    sessionTarget = { target: { ...target, password: newPassword }, serverName }
    const saved = getApp().recentServers.find((r) => r.host === target.host && r.port === target.port)
    if (saved?.password) {
      const recentServers = await window.zvon.rememberServer(target.host, target.port, saved.name, newPassword, saved.adminToken, saved.login)
      setApp({ recentServers })
    }
  }
  return null
}

/** Профиль: ник и (необязательно) новая аватарка; avatar === null — убрать аватарку. */
export async function updateProfile(nickname: string, avatar?: { blob: Blob; dataUrl: string } | null): Promise<string | null> {
  if (!client) return t('conn.lost')
  try {
    if (avatar) {
      await uploadAndSetAvatar(avatar.blob)
      setLocalAvatar(avatar.dataUrl)
    }
    const { user } = await client.request('profile-update', avatar === null ? { nickname, avatar: null } : { nickname })
    if (avatar === null) setLocalAvatar(null)
    client.updateHello({ nickname: user.nickname })
    setApp((s) => ({ me: user, users: { ...s.users, [user.id]: user }, nickname: user.nickname }))
    await window.zvon.setNickname(user.nickname)
    return null
  } catch (err) {
    return (err as Error).message
  }
}

function wireEvents(c: ZvonClient): void {
  unsubscribers.push(
    c.on('msg-new', ({ message }) => onIncomingMessage(message)),
    c.on('msg-updated', ({ message }) => {
      patchChannel(message.channelId, (ch) => ({ ...ch, items: ch.items.map((m) => (m.id === message.id ? message : m)) }))
    }),
    c.on('msg-deleted', ({ messageId, channelId }) => {
      patchChannel(channelId, (ch) => ({ ...ch, items: ch.items.filter((m) => m.id !== messageId) }))
      if (getApp().editingId === messageId) setApp({ editingId: null })
    }),
    c.on('typing', ({ channelId, userId }) => {
      setApp((s) => ({
        typing: { ...s.typing, [channelId]: { ...(s.typing[channelId] ?? {}), [userId]: Date.now() + TIMINGS.typingDisplayMs } }
      }))
    }),
    c.on('user-joined', ({ user }) => setApp((s) => ({ users: { ...s.users, [user.id]: user } }))),
    c.on('user-updated', ({ user }) => setApp((s) => ({ users: { ...s.users, [user.id]: user } }))),
    c.on('user-left', ({ userId }) =>
      setApp((s) => {
        const u = s.users[userId]
        return u ? { users: { ...s.users, [userId]: { ...u, online: false } } } : {}
      })
    ),
    c.on('channels-updated', ({ channels }) => onChannelsUpdated(channels)),
    c.on('server-settings', ({ maxUploadBytes }) => setApp({ maxUploadBytes })),
    c.on('server-closing', ({ reason }) => setApp({ connNotice: t('conn.serverClosing', { reason }) }))
  )
}

function onIncomingMessage(message: Message): void {
  const s = getApp()
  const ch = s.messages[message.channelId]
  if (ch?.loaded) patchChannel(message.channelId, (c) => ({ ...c, items: mergeMessages(c.items, [message]) }))

  // Автор перестал печатать.
  const typingInCh = s.typing[message.channelId]
  if (typingInCh?.[message.authorId]) {
    const rest = { ...typingInCh }
    delete rest[message.authorId]
    setApp((st) => ({ typing: { ...st.typing, [message.channelId]: rest } }))
  }

  const mentioned = isMentioned(message, s.me?.id)
  notifyIncoming(message, mentioned, () => selectChannel(message.channelId))
  const visible = message.channelId === s.currentChannelId && s.windowFocused && s.mainView === 'chat'
  if (!visible) {
    setApp((st) => {
      const u = st.unread[message.channelId] ?? { count: 0, mentions: 0 }
      return { unread: { ...st.unread, [message.channelId]: { count: u.count + 1, mentions: u.mentions + (mentioned ? 1 : 0) } } }
    })
  }
}

/** Хост изменил каналы: убираем удалённые из кэша, уходим из исчезнувшего голосового канала. */
function onChannelsUpdated(channels: Channel[]): void {
  const s = getApp()
  const ids = new Set(channels.map((c) => c.id))
  const messages = { ...s.messages }
  const unread = { ...s.unread }
  for (const id of Object.keys(messages)) if (!ids.has(id)) delete messages[id]
  for (const id of Object.keys(unread)) if (!ids.has(id)) delete unread[id]
  const firstText = channels.find((c) => c.type === 'text')?.id ?? null
  const currentChannelId = s.currentChannelId && ids.has(s.currentChannelId) ? s.currentChannelId : firstText
  setApp({ channels, messages, unread, currentChannelId })
  if (s.voiceChannelId && !ids.has(s.voiceChannelId)) void leaveVoice()
  if (currentChannelId && currentChannelId !== s.currentChannelId) void loadHistory(currentChannelId)
}

export function isMentioned(m: Message, myId: string | undefined): boolean {
  return Boolean(myId && m.authorId !== myId && (m.mentions.includes(myId) || m.mentions.includes('everyone')))
}

function disposeClient(): void {
  detachVoice()
  clearAllDrafts()
  while (unsubscribers.length) unsubscribers.pop()!()
  if (client) client.close()
  client = null
}

function returnToConnect(error: string | null): void {
  disposeClient()
  setApp({
    ...initialServerState,
    screen: 'connect',
    connecting: false,
    connectError: error,
    connStatus: 'closed',
    connNotice: null,
    target: null,
    isOwnServer: false
  })
}

export function disconnect(): void {
  returnToConnect(null)
}

/* ======================= хост ======================= */

export async function startHost(settings: HostSettings): Promise<void> {
  const nickname = getApp().nickname.trim()
  if (!nickname) {
    setApp({ connectError: t('connect.errNickname') })
    return
  }
  setApp({ connectError: null })
  try {
    const status = await window.zvon.startHost(settings)
    setApp({ hostStatus: status })
    rememberHostSettings(settings)
    await enterOwnServer()
  } catch (err) {
    setApp({ connectError: cleanError(err) })
  }
}

export async function enterOwnServer(): Promise<void> {
  const { hostStatus, boot } = getApp()
  if (hostStatus.state !== 'running' || !hostStatus.port) return
  await beginConnect({
    host: '127.0.0.1',
    port: hostStatus.port,
    password: boot?.hostSettings.password ?? '',
    remember: false
  })
}

export async function stopHost(): Promise<void> {
  try {
    if (getApp().isOwnServer) disconnect()
    const status = await window.zvon.stopHost()
    setApp({ hostStatus: status })
  } catch (err) {
    setApp({ connectError: cleanError(err) })
  }
}

/** Пароль, который хост ввёл последним, нужен для входа на свой сервер. */
export function rememberHostSettings(settings: HostSettings): void {
  setApp((s) => (s.boot ? { boot: { ...s.boot, hostSettings: settings } } : {}))
}

/* ======================= чат ======================= */

export function selectChannel(channelId: string): void {
  setApp({ currentChannelId: channelId, editingId: null, mainView: 'chat' })
  clearUnread(channelId)
  const ch = getApp().messages[channelId]
  if (!ch?.loaded) void loadHistory(channelId)
}

function clearUnread(channelId: string): void {
  if (!getApp().unread[channelId]) return
  setApp((s) => {
    const rest = { ...s.unread }
    delete rest[channelId]
    return { unread: rest }
  })
}

export async function loadHistory(channelId: string): Promise<void> {
  if (!client) return
  const cur = getApp().messages[channelId]
  if (cur?.loading) return
  patchChannel(channelId, (c) => ({ ...c, loading: true }))
  try {
    const res = await client.request('msg-history', { channelId, limit: LIMITS.historyPage })
    patchChannel(channelId, (c) => ({
      items: mergeMessages(c.items, res.messages),
      hasMore: res.hasMore,
      loading: false,
      loaded: true
    }))
  } catch (err) {
    console.warn('[zvon] не удалось загрузить историю', err)
    patchChannel(channelId, (c) => ({ ...c, loading: false }))
  }
}

export async function loadOlder(channelId: string): Promise<void> {
  if (!client) return
  const cur = getApp().messages[channelId]
  if (!cur || cur.loading || !cur.hasMore || cur.items.length === 0) return
  patchChannel(channelId, (c) => ({ ...c, loading: true }))
  try {
    const res = await client.request('msg-history', { channelId, before: cur.items[0].id, limit: LIMITS.historyPage })
    patchChannel(channelId, (c) => ({ ...c, items: mergeMessages(res.messages, c.items), hasMore: res.hasMore, loading: false }))
  } catch (err) {
    console.warn('[zvon] не удалось загрузить старые сообщения', err)
    patchChannel(channelId, (c) => ({ ...c, loading: false }))
  }
}

function setPending(channelId: string, fn: (list: PendingMessage[]) => PendingMessage[]): void {
  setApp((s) => ({ pending: { ...s.pending, [channelId]: fn(s.pending[channelId] ?? []) } }))
}

async function deliver(channelId: string, nonce: string, content: string, attachments: FileInfo[]): Promise<void> {
  if (!client) {
    setPending(channelId, (l) => l.map((p) => (p.nonce === nonce ? { ...p, failed: true } : p)))
    return
  }
  try {
    const { message } = await client.request('msg-send', {
      channelId,
      content,
      nonce,
      attachments: attachments.length ? attachments.map((a) => a.id) : undefined
    })
    setPending(channelId, (l) => l.filter((p) => p.nonce !== nonce))
    patchChannel(channelId, (c) => (c.loaded ? { ...c, items: mergeMessages(c.items, [message]) } : c))
  } catch (err) {
    console.warn('[zvon] сообщение не отправлено', err)
    setPending(channelId, (l) => l.map((p) => (p.nonce === nonce ? { ...p, failed: true } : p)))
  }
}

export function sendMessage(channelId: string, raw: string, attachments: FileInfo[] = []): void {
  const content = raw.replace(/\s+$/u, '')
  if (!content.trim() && attachments.length === 0) return
  const nonce = randomNonce()
  setPending(channelId, (l) => [...l, { nonce, channelId, content, attachments, createdAt: Date.now(), failed: false }])
  lastTypingSent = 0
  void deliver(channelId, nonce, content, attachments)
}

export function retryPending(channelId: string, nonce: string): void {
  const p = getApp().pending[channelId]?.find((x) => x.nonce === nonce)
  if (!p) return
  setPending(channelId, (l) => l.map((x) => (x.nonce === nonce ? { ...x, failed: false } : x)))
  void deliver(channelId, nonce, p.content, p.attachments)
}

export function discardPending(channelId: string, nonce: string): void {
  setPending(channelId, (l) => l.filter((x) => x.nonce !== nonce))
}

function retryFailedPending(): void {
  for (const [channelId, list] of Object.entries(getApp().pending)) {
    for (const p of list) if (p.failed) retryPending(channelId, p.nonce)
  }
}

export async function editMessage(messageId: number, content: string): Promise<string | null> {
  if (!client) return t('conn.lost')
  try {
    const { message } = await client.request('msg-edit', { messageId, content })
    patchChannel(message.channelId, (c) => ({ ...c, items: c.items.map((m) => (m.id === message.id ? message : m)) }))
    setApp({ editingId: null })
    return null
  } catch (err) {
    return (err as Error).message
  }
}

export async function deleteMessage(messageId: number, channelId: string): Promise<string | null> {
  if (!client) return t('conn.lost')
  try {
    await client.request('msg-delete', { messageId })
    patchChannel(channelId, (c) => ({ ...c, items: c.items.filter((m) => m.id !== messageId) }))
    return null
  } catch (err) {
    return (err as Error).message
  }
}

export function notifyTyping(channelId: string): void {
  const now = Date.now()
  if (!client || now - lastTypingSent < TIMINGS.typingThrottleMs) return
  lastTypingSent = now
  client.request('typing', { channelId }).catch(() => {
    /* «печатает» не критично */
  })
}

export async function updateNickname(nickname: string): Promise<string | null> {
  return updateProfile(nickname)
}

/** Запрос к серверу от панели хоста (права проверяет сервер). */
export function adminRequest<K extends RequestType>(type: K, data: RequestMap[K]): Promise<ResponseMap[K]> {
  if (!client) return Promise.reject(new Error(t('conn.lost')))
  return client.request(type, data)
}
