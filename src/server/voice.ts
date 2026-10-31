/**
 * Голосовые комнаты: состояние участников, транспорты, producers/consumers,
 * определение говорящих. Один роутер mediasoup на голосовой канал.
 */
import { ErrorCode } from '../shared/constants'
import type {
  ConsumerInfo,
  EventMap,
  EventType,
  MediaJson,
  MediaKind,
  MediaSource,
  ProducerInfo,
  RequestMap,
  TransportInfo,
  VoiceState
} from '../shared/types'
import type { Logger } from './logger'
import { RequestError } from './session'
import type { Consumer, Producer, Router, RtpCapabilities, SfuService, WebRtcTransport } from './sfu'

type AudioLevelObserver = ReturnType<Router['createAudioLevelObserver']> extends Promise<infer T> ? T : never
type ActiveSpeakerObserver = ReturnType<Router['createActiveSpeakerObserver']> extends Promise<infer T> ? T : never
type RtpParameters = Parameters<WebRtcTransport['produce']>[0]['rtpParameters']
type DtlsParameters = Parameters<WebRtcTransport['connect']>[0]['dtlsParameters']

const MAX_PEERS_PER_ROOM = 25

interface VoicePeer {
  userId: string
  state: VoiceState
  rtpCapabilities: RtpCapabilities | null
  transports: Map<string, WebRtcTransport>
  producers: Map<string, Producer>
  consumers: Map<string, Consumer>
}

interface Room {
  channelId: string
  router: Router
  levels: AudioLevelObserver
  speaker: ActiveSpeakerObserver
  peers: Map<string, VoicePeer>
}

export interface VoiceIo {
  /** Отправить событие одному пользователю (если он сейчас подключён). */
  send<E extends EventType>(userId: string, t: E, d: EventMap[E]): void
  /** Разослать всем подключённым. */
  broadcast<E extends EventType>(t: E, d: EventMap[E]): void
  /** Проверка, что голосовой канал существует. */
  isVoiceChannel(channelId: string): boolean
}

function sourceOf(p: { appData: Record<string, unknown> }): MediaSource {
  const s = p.appData.source
  return s === 'camera' || s === 'screen' || s === 'screen-audio' ? s : 'mic'
}

export class VoiceManager {
  private rooms = new Map<string, Room>()
  private creating = new Map<string, Promise<Room>>()
  /** Где сейчас находится пользователь. */
  private where = new Map<string, string>()

  constructor(
    private sfu: SfuService,
    private io: VoiceIo,
    private log: Logger
  ) {
    sfu.on('reset', (reason: string) => this.resetAll(reason))
  }

  /* ======================= состояние ======================= */

  states(): VoiceState[] {
    const out: VoiceState[] = []
    for (const room of this.rooms.values()) for (const p of room.peers.values()) out.push(p.state)
    return out
  }

  counts(): { rooms: number; peers: number; producers: number; consumers: number } {
    let peers = 0
    let producers = 0
    let consumers = 0
    for (const room of this.rooms.values()) {
      for (const p of room.peers.values()) {
        peers++
        producers += p.producers.size
        consumers += p.consumers.size
      }
    }
    return { rooms: this.rooms.size, peers, producers, consumers }
  }

  private peerOf(userId: string): { room: Room; peer: VoicePeer } {
    const channelId = this.where.get(userId)
    const room = channelId ? this.rooms.get(channelId) : undefined
    const peer = room?.peers.get(userId)
    if (!room || !peer) throw new RequestError(ErrorCode.BadRequest, 'Вы не в голосовом канале')
    return { room, peer }
  }

  private requireSfu(): void {
    if (!this.sfu.available) {
      throw new RequestError(ErrorCode.Internal, `Голос недоступен: ${this.sfu.error ?? 'медиасервер не запущен'}`)
    }
  }

  /* ======================= комнаты ======================= */

  private async getRoom(channelId: string): Promise<Room> {
    const existing = this.rooms.get(channelId)
    if (existing) return existing
    const pending = this.creating.get(channelId)
    if (pending) return pending
    const promise = this.createRoom(channelId).finally(() => this.creating.delete(channelId))
    this.creating.set(channelId, promise)
    return promise
  }

  private async createRoom(channelId: string): Promise<Room> {
    const router = await this.sfu.createRouter()
    const levels = await router.createAudioLevelObserver({ maxEntries: 25, threshold: -60, interval: 300 })
    const speaker = await router.createActiveSpeakerObserver({ interval: 300 })
    const room: Room = { channelId, router, levels, speaker, peers: new Map() }

    levels.on('volumes', (volumes) => {
      const map: Record<string, number> = {}
      for (const v of volumes) {
        const userId = v.producer.appData.userId
        if (typeof userId === 'string') map[userId] = Math.round(v.volume)
      }
      this.io.broadcast('speaking', { channelId, levels: map })
    })
    levels.on('silence', () => this.io.broadcast('speaking', { channelId, levels: {} }))
    speaker.on('dominantspeaker', ({ producer }) => {
      const userId = producer.appData.userId
      this.io.broadcast('active-speaker', { channelId, userId: typeof userId === 'string' ? userId : null })
    })

    router.observer.on('close', () => {
      if (this.rooms.get(channelId) === room) this.rooms.delete(channelId)
    })
    this.rooms.set(channelId, room)
    this.log.info(`Создана голосовая комната ${channelId}`)
    return room
  }

  private closeRoomIfEmpty(room: Room): void {
    if (room.peers.size > 0) return
    this.rooms.delete(room.channelId)
    try {
      room.router.close()
    } catch (err) {
      this.log.warn('Ошибка закрытия роутера', err)
    }
    this.log.info(`Голосовая комната ${room.channelId} закрыта (пусто)`)
  }

  /**
   * Пересчитывает, ведёт ли участник демонстрацию и чьи демонстрации смотрит,
   * и рассылает его состояние, если что-то изменилось. Смотрит — значит приём видео экрана не на паузе
   * (клиент ставит его на паузу, когда плитка скрыта или окно свёрнуто).
   */
  private refreshMediaState(peer: VoicePeer): void {
    const channelId = this.where.get(peer.userId)
    if (!channelId || this.rooms.get(channelId)?.peers.get(peer.userId) !== peer) return
    const streaming = [...peer.producers.values()].some((p) => !p.closed && p.kind === 'video' && sourceOf(p) === 'screen')
    const watching = new Set<string>()
    for (const c of peer.consumers.values()) {
      if (!c.closed && !c.paused && c.kind === 'video' && sourceOf(c) === 'screen') watching.add(String(c.appData.userId))
    }
    const list = [...watching].sort()
    if (streaming === peer.state.streaming && list.join() === peer.state.watching.join()) return
    peer.state = { ...peer.state, streaming, watching: list }
    this.io.broadcast('voice-state', { userId: peer.userId, state: peer.state })
  }

  /* ======================= вход и выход ======================= */

  async join(userId: string, d: RequestMap['voice-join']): Promise<{ channelId: string; routerRtpCapabilities: MediaJson }> {
    this.requireSfu()
    if (!this.io.isVoiceChannel(d.channelId)) throw new RequestError(ErrorCode.NotFound, 'Голосовой канал не найден')

    // Повторный вход (в том числе после переподключения) — начинаем с чистого листа.
    const previous = this.where.get(userId)
    const keepState = previous === d.channelId
    const oldState = keepState ? this.rooms.get(d.channelId)?.peers.get(userId)?.state : undefined
    if (previous) this.leave(userId, !keepState)

    let room: Room
    try {
      room = await this.getRoom(d.channelId)
    } catch (err) {
      this.log.error('Не удалось создать голосовую комнату', err)
      throw new RequestError(ErrorCode.Internal, `Голос недоступен: ${(err as Error).message}`)
    }
    if (room.peers.size >= MAX_PEERS_PER_ROOM) throw new RequestError(ErrorCode.Forbidden, 'Голосовой канал переполнен')

    // Демонстрации и просмотры после перехода начинаются заново — их состояние пересчитывается по потокам.
    const state: VoiceState = oldState
      ? { ...oldState, streaming: false, watching: [] }
      : { userId, channelId: d.channelId, muted: false, deafened: false, joinedAt: Date.now(), streaming: false, watching: [] }
    room.peers.set(userId, {
      userId,
      state,
      rtpCapabilities: null,
      transports: new Map(),
      producers: new Map(),
      consumers: new Map()
    })
    this.where.set(userId, d.channelId)
    this.io.broadcast('voice-state', { userId, state })
    this.log.info(`${userId} вошёл в голосовой канал ${d.channelId}`)
    return { channelId: d.channelId, routerRtpCapabilities: room.router.rtpCapabilities as unknown as MediaJson }
  }

  ready(userId: string, d: RequestMap['voice-ready']): { producers: ProducerInfo[] } {
    const { room, peer } = this.peerOf(userId)
    peer.rtpCapabilities = d.rtpCapabilities as unknown as RtpCapabilities
    const producers: ProducerInfo[] = []
    for (const other of room.peers.values()) {
      if (other.userId === userId) continue
      for (const p of other.producers.values()) producers.push(this.producerInfo(room, other, p))
    }
    return { producers }
  }

  /** Выход из голоса: закрывает все транспорты пользователя. */
  leave(userId: string, announce = true): void {
    const channelId = this.where.get(userId)
    if (!channelId) return
    this.where.delete(userId)
    const room = this.rooms.get(channelId)
    const peer = room?.peers.get(userId)
    if (!room || !peer) return
    room.peers.delete(userId)
    // Закрытие транспорта закрывает его producers и consumers; события разошлём сами.
    for (const p of peer.producers.values()) this.notifyProducerClosed(room, peer, p.id)
    for (const t of peer.transports.values()) {
      try {
        t.close()
      } catch (err) {
        this.log.warn('Ошибка закрытия транспорта', err)
      }
    }
    peer.transports.clear()
    peer.producers.clear()
    peer.consumers.clear()
    if (announce) this.io.broadcast('voice-state', { userId, state: null })
    this.log.info(`${userId} вышел из голосового канала ${channelId}`)
    this.closeRoomIfEmpty(room)
  }

  updateState(userId: string, d: RequestMap['voice-state-update']): { state: VoiceState } {
    const { peer } = this.peerOf(userId)
    peer.state = { ...peer.state, muted: d.muted, deafened: d.deafened }
    this.io.broadcast('voice-state', { userId, state: peer.state })
    return { state: peer.state }
  }

  /* ======================= транспорты ======================= */

  async createTransport(userId: string, d: RequestMap['transport-create']): Promise<TransportInfo> {
    this.requireSfu()
    const { room, peer } = this.peerOf(userId)
    // Один транспорт каждого направления: старый закрываем.
    for (const t of peer.transports.values()) {
      if (t.appData.direction === d.direction) {
        t.close()
        peer.transports.delete(t.id)
      }
    }
    const transport = await this.sfu.createTransport(room.router, { userId, direction: d.direction })
    peer.transports.set(transport.id, transport)

    transport.on('dtlsstatechange', (state) => {
      if (state === 'failed' || state === 'closed') {
        this.log.warn(`DTLS ${state} у ${userId} (${d.direction})`)
      }
    })
    transport.on('icestatechange', (state) => {
      if (state === 'disconnected') this.log.info(`ICE disconnected у ${userId} (${d.direction}), ждём восстановления`)
    })
    transport.observer.on('close', () => peer.transports.delete(transport.id))

    return {
      id: transport.id,
      iceParameters: transport.iceParameters as unknown as MediaJson,
      iceCandidates: transport.iceCandidates as unknown as MediaJson[],
      dtlsParameters: transport.dtlsParameters as unknown as MediaJson
    }
  }

  private transportOf(peer: VoicePeer, transportId: string): WebRtcTransport {
    const t = peer.transports.get(transportId)
    if (!t) throw new RequestError(ErrorCode.NotFound, 'Транспорт не найден')
    return t
  }

  async connectTransport(userId: string, d: RequestMap['transport-connect']): Promise<Record<string, never>> {
    const { peer } = this.peerOf(userId)
    const t = this.transportOf(peer, d.transportId)
    await t.connect({ dtlsParameters: d.dtlsParameters as unknown as DtlsParameters })
    return {}
  }

  async restartIce(userId: string, d: RequestMap['transport-restart-ice']): Promise<{ iceParameters: MediaJson }> {
    const { peer } = this.peerOf(userId)
    const t = this.transportOf(peer, d.transportId)
    const iceParameters = await t.restartIce()
    this.log.info(`ICE restart у ${userId}`)
    return { iceParameters: iceParameters as unknown as MediaJson }
  }

  /* ======================= producers ======================= */

  private producerInfo(room: Room, peer: VoicePeer, p: Producer): ProducerInfo {
    return {
      producerId: p.id,
      userId: peer.userId,
      channelId: room.channelId,
      kind: p.kind as MediaKind,
      source: sourceOf(p),
      paused: p.paused
    }
  }

  private notifyProducerClosed(room: Room, owner: VoicePeer, producerId: string): void {
    for (const other of room.peers.values()) {
      if (other.userId !== owner.userId) this.io.send(other.userId, 'producer-closed', { producerId, userId: owner.userId })
    }
  }

  async produce(userId: string, d: RequestMap['produce']): Promise<{ producerId: string }> {
    this.requireSfu()
    const { room, peer } = this.peerOf(userId)
    const transport = this.transportOf(peer, d.transportId)
    if (transport.appData.direction !== 'send') throw new RequestError(ErrorCode.BadRequest, 'Это не транспорт отправки')
    if ((d.source === 'mic' || d.source === 'screen-audio') !== (d.kind === 'audio')) {
      throw new RequestError(ErrorCode.BadRequest, 'Тип потока не соответствует источнику')
    }

    // Один поток каждого источника: новый заменяет старый.
    for (const p of peer.producers.values()) {
      if (sourceOf(p) === d.source) {
        p.close()
        peer.producers.delete(p.id)
        this.notifyProducerClosed(room, peer, p.id)
      }
    }

    let producer: Producer
    try {
      producer = await transport.produce({
        kind: d.kind,
        rtpParameters: d.rtpParameters as unknown as RtpParameters,
        paused: d.paused ?? false,
        appData: { userId, source: d.source }
      })
    } catch (err) {
      throw new RequestError(ErrorCode.BadRequest, `Сервер не принял поток: ${(err as Error).message}`)
    }
    peer.producers.set(producer.id, producer)

    producer.on('transportclose', () => peer.producers.delete(producer.id))
    producer.observer.on('close', () => {
      peer.producers.delete(producer.id)
      this.refreshMediaState(peer)
    })

    if (d.source === 'mic') {
      room.levels.addProducer({ producerId: producer.id }).catch((err) => this.log.warn('AudioLevelObserver', err))
      room.speaker.addProducer({ producerId: producer.id }).catch((err) => this.log.warn('ActiveSpeakerObserver', err))
    }

    const info = this.producerInfo(room, peer, producer)
    for (const other of room.peers.values()) {
      // Новый поток получают только те, кто уже готов принимать (прислал rtpCapabilities).
      if (other.userId !== userId && other.rtpCapabilities) this.io.send(other.userId, 'new-producer', info)
    }
    this.log.info(`${userId}: новый поток ${d.source}/${d.kind} ${producer.id}`)
    this.refreshMediaState(peer)
    return { producerId: producer.id }
  }

  private producerOf(peer: VoicePeer, producerId: string): Producer {
    const p = peer.producers.get(producerId)
    if (!p) throw new RequestError(ErrorCode.NotFound, 'Поток не найден')
    return p
  }

  closeProducer(userId: string, d: RequestMap['producer-close']): Record<string, never> {
    const { room, peer } = this.peerOf(userId)
    const p = this.producerOf(peer, d.producerId)
    p.close()
    peer.producers.delete(p.id)
    this.notifyProducerClosed(room, peer, p.id)
    return {}
  }

  async pauseProducer(userId: string, d: RequestMap['producer-pause']): Promise<Record<string, never>> {
    const { peer } = this.peerOf(userId)
    await this.producerOf(peer, d.producerId).pause()
    return {}
  }

  async resumeProducer(userId: string, d: RequestMap['producer-resume']): Promise<Record<string, never>> {
    const { peer } = this.peerOf(userId)
    await this.producerOf(peer, d.producerId).resume()
    return {}
  }

  /* ======================= consumers ======================= */

  async consume(userId: string, d: RequestMap['consume']): Promise<ConsumerInfo> {
    this.requireSfu()
    const { room, peer } = this.peerOf(userId)
    if (!peer.rtpCapabilities) throw new RequestError(ErrorCode.BadRequest, 'Сначала voice-ready')

    let owner: VoicePeer | null = null
    let producer: Producer | null = null
    for (const other of room.peers.values()) {
      const p = other.producers.get(d.producerId)
      if (p) {
        owner = other
        producer = p
        break
      }
    }
    if (!owner || !producer) throw new RequestError(ErrorCode.NotFound, 'Поток уже закрыт')
    if (owner.userId === userId) throw new RequestError(ErrorCode.BadRequest, 'Нельзя принимать собственный поток')
    if (!room.router.canConsume({ producerId: producer.id, rtpCapabilities: peer.rtpCapabilities })) {
      throw new RequestError(ErrorCode.BadRequest, 'Ваш клиент не поддерживает кодек этого потока')
    }
    const recv = [...peer.transports.values()].find((t) => t.appData.direction === 'recv')
    if (!recv) throw new RequestError(ErrorCode.BadRequest, 'Нет транспорта приёма')

    // Создаём на паузе: клиент снимет паузу, когда подготовит трек.
    const consumer = await recv.consume({
      producerId: producer.id,
      rtpCapabilities: peer.rtpCapabilities,
      paused: true,
      appData: { userId: owner.userId, source: sourceOf(producer) }
    })
    peer.consumers.set(consumer.id, consumer)

    const drop = (): void => {
      peer.consumers.delete(consumer.id)
      this.refreshMediaState(peer)
    }
    consumer.on('transportclose', drop)
    consumer.on('producerclose', () => {
      drop()
      this.io.send(userId, 'consumer-closed', { consumerId: consumer.id, producerId: producer.id })
    })
    consumer.on('layerschange', (layers) => {
      this.io.send(userId, 'consumer-layers', {
        consumerId: consumer.id,
        spatialLayer: layers?.spatialLayer ?? null,
        temporalLayer: layers?.temporalLayer ?? null
      })
    })

    // Число слоёв видно из scalabilityMode: «S3T3» у simulcast, «L3T3» у SVC.
    const encoding = (consumer.rtpParameters.encodings?.[0] ?? {}) as { scalabilityMode?: string }
    const layers = /^[LS](\d+)T(\d+)/.exec(encoding.scalabilityMode ?? '')

    return {
      consumerId: consumer.id,
      producerId: producer.id,
      userId: owner.userId,
      kind: consumer.kind as MediaKind,
      source: sourceOf(producer),
      rtpParameters: consumer.rtpParameters as unknown as MediaJson,
      producerPaused: consumer.producerPaused,
      spatialLayers: layers ? Number(layers[1]) : 1,
      temporalLayers: layers ? Number(layers[2]) : 1
    }
  }

  private consumerOf(peer: VoicePeer, consumerId: string): Consumer {
    const c = peer.consumers.get(consumerId)
    if (!c) throw new RequestError(ErrorCode.NotFound, 'Приёмник потока не найден')
    return c
  }

  async resumeConsumer(userId: string, d: RequestMap['consumer-resume']): Promise<Record<string, never>> {
    const { peer } = this.peerOf(userId)
    await this.consumerOf(peer, d.consumerId).resume()
    this.refreshMediaState(peer)
    return {}
  }

  async pauseConsumer(userId: string, d: RequestMap['consumer-pause']): Promise<Record<string, never>> {
    const { peer } = this.peerOf(userId)
    await this.consumerOf(peer, d.consumerId).pause()
    this.refreshMediaState(peer)
    return {}
  }

  /** Зритель выбирает качество: SFU не пошлёт слой выше выбранного (и ниже, если канал не тянет). */
  async setConsumerLayers(userId: string, d: RequestMap['consumer-set-layers']): Promise<Record<string, never>> {
    const { peer } = this.peerOf(userId)
    const c = this.consumerOf(peer, d.consumerId)
    if (c.type !== 'simulcast' && c.type !== 'svc') return {}
    await c.setPreferredLayers({ spatialLayer: d.spatialLayer, temporalLayer: d.temporalLayer })
    return {}
  }

  /* ======================= панель хоста ======================= */

  channelOf(userId: string): string | null {
    return this.where.get(userId) ?? null
  }

  /** Битрейты и число потоков каждого участника голоса (по статистике транспортов). */
  async userStats(): Promise<Map<string, { sendKbps: number; recvKbps: number; producers: number; consumers: number }>> {
    const out = new Map<string, { sendKbps: number; recvKbps: number; producers: number; consumers: number }>()
    const jobs: Array<Promise<void>> = []
    for (const room of this.rooms.values()) {
      for (const peer of room.peers.values()) {
        const entry = { sendKbps: 0, recvKbps: 0, producers: peer.producers.size, consumers: peer.consumers.size }
        out.set(peer.userId, entry)
        for (const t of peer.transports.values()) {
          jobs.push(
            t
              .getStats()
              .then((stats) => {
                for (const st of stats) {
                  // sendBitrate — от хоста к клиенту, recvBitrate — от клиента к хосту.
                  entry.sendKbps += Math.round((st.sendBitrate ?? 0) / 1000)
                  entry.recvKbps += Math.round((st.recvBitrate ?? 0) / 1000)
                }
              })
              .catch(() => undefined)
          )
        }
      }
    }
    await Promise.all(jobs)
    return out
  }

  /** Новые лимиты битрейта — ко всем существующим транспортам. */
  async applyLimits(): Promise<void> {
    const jobs: Array<Promise<void>> = []
    for (const room of this.rooms.values()) {
      for (const peer of room.peers.values()) for (const t of peer.transports.values()) jobs.push(this.sfu.applyLimits(t))
    }
    await Promise.all(jobs)
  }

  /** Канал удалён — все его участники выходят из голоса. */
  closeChannel(channelId: string): void {
    for (const [userId, ch] of [...this.where]) if (ch === channelId) this.leave(userId)
  }

  /* ======================= аварии и остановка ======================= */

  /** Воркер упал: все роутеры уже закрыты, сбрасываем состояние и просим клиентов переподключиться. */
  private resetAll(reason: string): void {
    const users = [...this.where.keys()]
    this.rooms.clear()
    this.creating.clear()
    this.where.clear()
    for (const userId of users) this.io.broadcast('voice-state', { userId, state: null })
    this.io.broadcast('voice-reset', { reason })
    this.log.warn(`Голос сброшен: ${reason}, затронуто участников: ${users.length}`)
  }

  closeAll(): void {
    for (const userId of [...this.where.keys()]) this.leave(userId, false)
  }
}
