import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isPoppedOut, openPopout } from '../lib/popout'
import { useApp } from '../store/app'
import { selectChannel } from '../store/session'
import {
  leaveVoice,
  openScreenPicker,
  setFocusedTile,
  setManualLayer,
  setWatching,
  stopScreenShare,
  toggleCamera,
  toggleDeafen,
  toggleMute,
  wantVideo
} from '../store/voice'
import type { RemoteVideoView } from '../voice/engine'
import { Avatar } from './Common'
import {
  CameraIcon,
  CameraOffIcon,
  EyeIcon,
  EyeOffIcon,
  ExpandIcon,
  FocusIcon,
  HeadphonesIcon,
  HeadphonesOffIcon,
  MicIcon,
  MicOffIcon,
  PhoneOffIcon,
  PopoutIcon,
  ScreenIcon,
  ScreenOffIcon,
  VolumeIcon
} from './Icons'
import { ScreenPicker } from './ScreenPicker'
import { CAN_SHARE_SCREEN } from '../edition'

interface TileModel {
  key: string
  kind: 'cam' | 'screen'
  userId: string
  remote: RemoteVideoView | null
  local: MediaStreamTrack | null
}

const EMPTY: Record<string, number> = {}

function qualityLabels(t: (k: string) => string, layers: number): string[] {
  if (layers <= 1) return [t('stage.qualityHigh')]
  if (layers === 2) return [t('stage.qualityLow'), t('stage.qualityHigh')]
  return [t('stage.qualityLow'), t('stage.qualityMedium'), t('stage.qualityHigh')]
}

/** Желаемый слой по размеру плитки на экране. */
function layerForWidth(width: number, maxLayer: number): number {
  const byWidth = width < 360 ? 0 : width < 900 ? 1 : 2
  return Math.min(maxLayer, byWidth)
}

export function VoiceStage() {
  const { t } = useTranslation()
  const channelId = useApp((s) => s.voiceChannelId)
  const channels = useApp((s) => s.channels)
  const voiceStates = useApp((s) => s.voiceStates)
  const remoteVideos = useApp((s) => s.remoteVideos)
  const local = useApp((s) => s.localMedia)
  const myId = useApp((s) => s.me?.id)
  const focused = useApp((s) => s.focusedTile)
  const mediaError = useApp((s) => s.mediaError)
  const pickerOpen = useApp((s) => s.screenPickerOpen)
  const currentText = useApp((s) => s.currentChannelId)
  const channel = channels.find((c) => c.id === channelId)

  const tiles = useMemo<TileModel[]>(() => {
    const members = Object.values(voiceStates)
      .filter((v) => v.channelId === channelId)
      .sort((a, b) => a.joinedAt - b.joinedAt)
    const screens: TileModel[] = []
    const cams: TileModel[] = []
    for (const m of members) {
      const isMe = m.userId === myId
      const screenRemote = remoteVideos.find((v) => v.userId === m.userId && v.source === 'screen') ?? null
      const camRemote = remoteVideos.find((v) => v.userId === m.userId && v.source === 'camera') ?? null
      if ((isMe && local.screen) || screenRemote) {
        screens.push({ key: `screen:${m.userId}`, kind: 'screen', userId: m.userId, remote: screenRemote, local: isMe ? local.screen : null })
      }
      cams.push({ key: `cam:${m.userId}`, kind: 'cam', userId: m.userId, remote: camRemote, local: isMe ? local.camera : null })
    }
    return [...screens, ...cams]
  }, [voiceStates, channelId, remoteVideos, local, myId])

  const focusedTile = tiles.find((x) => x.key === focused) ?? null

  return (
    <main className="stage">
      <header className="chat-header">
        <VolumeIcon width={22} height={22} />
        <h3>{channel?.name ?? ''}</h3>
        <span className="spacer" />
        {currentText && (
          <button className="btn btn-small btn-secondary" onClick={() => selectChannel(currentText)}>
            {t('stage.toChat')}
          </button>
        )}
      </header>
      {mediaError && <div className="banner banner-warn">{mediaError}</div>}
      <div className="stage-body">
        {tiles.length === 0 ? (
          <div className="chat-empty">{t('stage.empty')}</div>
        ) : focusedTile ? (
          <div className="stage-focus-layout">
            <div className="stage-focus">
              <VideoTile tile={focusedTile} big />
            </div>
            <div className="stage-strip">
              {tiles
                .filter((x) => x.key !== focusedTile.key)
                .map((x) => (
                  <div className="strip-item" key={x.key}>
                    <VideoTile tile={x} />
                  </div>
                ))}
            </div>
          </div>
        ) : (
          <div className={tiles.length === 1 ? 'stage-grid single' : 'stage-grid'}>
            {tiles.map((x) => (
              <VideoTile key={x.key} tile={x} />
            ))}
          </div>
        )}
      </div>
      <StageControls />
      {pickerOpen && <ScreenPicker />}
    </main>
  )
}

/** Кто смотрит демонстрацию: значок с числом зрителей, по нажатию — список. */
function StreamViewers({ streamerId }: { streamerId: string }) {
  const { t } = useTranslation()
  const voiceStates = useApp((s) => s.voiceStates)
  const users = useApp((s) => s.users)
  const [open, setOpen] = useState(false)
  const names = Object.values(voiceStates)
    .filter((v) => v.userId !== streamerId && v.watching?.includes(streamerId))
    .map((v) => users[v.userId]?.nickname ?? '…')
    .sort((a, b) => a.localeCompare(b))
  return (
    <div className="tile-viewers-wrap" onDoubleClick={(e) => e.stopPropagation()}>
      <button className="tile-viewers" title={names.join(', ') || t('stage.viewersNone')} onClick={() => setOpen((v) => !v)}>
        <span className="live-badge">{t('stage.live')}</span>
        <EyeIcon width={14} height={14} />
        {names.length}
      </button>
      {open && (
        <div className="tile-menu viewers-menu" onMouseLeave={() => setOpen(false)}>
          <div className="viewers-title">{t('stage.viewersTitle')}</div>
          {names.length === 0 ? <div className="viewers-empty">{t('stage.viewersNone')}</div> : names.map((n) => <div key={n}>{n}</div>)}
        </div>
      )}
    </div>
  )
}

function VideoTile({ tile, big = false }: { tile: TileModel; big?: boolean }) {
  const { t } = useTranslation()
  const user = useApp((s) => s.users[tile.userId])
  const voice = useApp((s) => s.voiceStates[tile.userId])
  const levels = useApp((s) => (s.voiceChannelId ? s.speaking[s.voiceChannelId] : undefined)) ?? EMPTY
  const watching = useApp((s) => Boolean(s.watching[tile.userId]))
  const focused = useApp((s) => s.focusedTile === tile.key)
  const myId = useApp((s) => s.me?.id)
  const boxRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [width, setWidth] = useState(0)
  const [visible, setVisible] = useState(true)
  const [fullscreen, setFullscreen] = useState(false)
  const [menu, setMenu] = useState(false)
  const [, rerender] = useState(0)

  const remote = tile.remote
  const track = remote?.track ?? tile.local
  const name = user?.nickname ?? '…'
  const isMe = tile.userId === myId
  const needsWatch = tile.kind === 'screen' && remote !== null && !watching
  const speaking = tile.kind === 'cam' && levels[tile.userId] !== undefined && !voice?.muted
  const popped = remote ? isPoppedOut(tile.key) : false

  // Размер и видимость плитки определяют, нужен ли поток и какого качества.
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)))
    const io = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting))
    ro.observe(el)
    io.observe(el)
    const onFs = (): void => setFullscreen(document.fullscreenElement === el)
    document.addEventListener('fullscreenchange', onFs)
    return () => {
      ro.disconnect()
      io.disconnect()
      document.removeEventListener('fullscreenchange', onFs)
    }
  }, [])

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    if (track && !needsWatch) {
      v.srcObject = new MediaStream([track])
      v.play().catch(() => undefined)
    } else {
      v.srcObject = null
    }
  }, [track, needsWatch])

  const consumerId = remote?.consumerId
  const maxLayer = (remote?.spatialLayers ?? 1) - 1
  const wantLayer = fullscreen || big ? maxLayer : layerForWidth(width || 640, maxLayer)
  const wanted = Boolean(remote) && !needsWatch && visible && width > 0
  useEffect(() => {
    if (!consumerId) return
    const viewer = `tile:${tile.key}`
    wantVideo(consumerId, viewer, wanted ? wantLayer : null)
    return () => wantVideo(consumerId, viewer, null)
  }, [consumerId, wanted, wantLayer, tile.key])

  const toggleFullscreen = (): void => {
    const el = boxRef.current
    if (!el) return
    if (document.fullscreenElement) void document.exitFullscreen()
    else void el.requestFullscreen().catch(() => undefined)
  }

  const labels = qualityLabels(t, remote?.spatialLayers ?? 1)
  const qualityNow =
    remote && remote.spatialLayers > 1 && remote.currentSpatial !== null ? labels[Math.min(remote.currentSpatial, labels.length - 1)] : null
  const title = tile.kind === 'screen' ? (isMe ? t('stage.yourScreen') : t('stage.screenOf', { name })) : `${name}${isMe ? ` (${t('stage.you')})` : ''}`
  const showVideo = Boolean(track) && !needsWatch

  return (
    <div
      ref={boxRef}
      className={['tile', tile.kind, speaking ? 'speaking' : '', big ? 'big' : '', showVideo ? 'has-video' : '', isMe ? 'me' : ''].join(' ')}
      onDoubleClick={toggleFullscreen}
    >
      <video ref={videoRef} autoPlay playsInline muted className={showVideo ? '' : 'hidden'} />
      {!showVideo && (
        <div className="tile-placeholder">
          <Avatar id={tile.userId} nickname={name} size={big ? 96 : 64} />
          {needsWatch && (
            <button className="btn btn-primary" onClick={() => setWatching(tile.userId, true)}>
              <ScreenIcon width={16} height={16} />
              {t('stage.watch')}
            </button>
          )}
          {popped && <div className="tile-note">{t('stage.popout')}</div>}
        </div>
      )}
      {remote && showVideo && !remote.active && <div className="tile-paused">{t('stage.paused')}</div>}

      {tile.kind === 'screen' && <StreamViewers streamerId={tile.userId} />}

      <div className="tile-label">
        {voice?.deafened ? (
          <HeadphonesOffIcon width={14} height={14} className="voice-flag" />
        ) : voice?.muted && tile.kind === 'cam' ? (
          <MicOffIcon width={14} height={14} className="voice-flag" />
        ) : null}
        <span>{title}</span>
        {qualityNow && <span className="tile-quality">{qualityNow}</span>}
      </div>

      <div className="tile-actions">
        {remote && showVideo && remote.spatialLayers > 1 && (
          <div className="tile-menu-wrap">
            <button className="tile-btn" title={t('stage.quality')} onClick={() => setMenu((v) => !v)}>
              {remote.manualLayer === null ? t('stage.qualityAuto') : labels[remote.manualLayer]}
            </button>
            {menu && (
              <div className="tile-menu" onMouseLeave={() => setMenu(false)}>
                <button
                  className={remote.manualLayer === null ? 'active' : ''}
                  onClick={() => {
                    setManualLayer(remote.consumerId, null)
                    setMenu(false)
                  }}
                >
                  {t('stage.qualityAuto')}
                </button>
                {labels
                  .map((label, i) => ({ label, i }))
                  .reverse()
                  .map(({ label, i }) => (
                    <button
                      key={i}
                      className={remote.manualLayer === i ? 'active' : ''}
                      onClick={() => {
                        setManualLayer(remote.consumerId, i)
                        setMenu(false)
                      }}
                    >
                      {label}
                    </button>
                  ))}
              </div>
            )}
          </div>
        )}
        {tile.kind === 'screen' && remote && watching && (
          <button className="tile-btn" title={t('stage.stopWatching')} onClick={() => setWatching(tile.userId, false)}>
            <EyeOffIcon width={16} height={16} />
          </button>
        )}
        {remote && showVideo && (
          <button
            className="tile-btn"
            title={t('stage.popout')}
            onClick={() => {
              openPopout(remote, title)
              rerender((n) => n + 1)
            }}
          >
            <PopoutIcon width={16} height={16} />
          </button>
        )}
        <button className="tile-btn" title={focused ? t('stage.unfocus') : t('stage.focus')} onClick={() => setFocusedTile(focused ? null : tile.key)}>
          <FocusIcon width={16} height={16} />
        </button>
        {showVideo && (
          <button className="tile-btn" title={fullscreen ? t('stage.exitFullscreen') : t('stage.fullscreen')} onClick={toggleFullscreen}>
            <ExpandIcon width={16} height={16} />
          </button>
        )}
      </div>
    </div>
  )
}

/** Нижняя панель сцены: микрофон, звук, камера, экран, отключение. */
export function StageControls() {
  const { t } = useTranslation()
  const muted = useApp((s) => s.selfMuted)
  const deafened = useApp((s) => s.selfDeafened)
  const camera = useApp((s) => s.localMedia.camera)
  const screen = useApp((s) => s.localMedia.screen)
  const connected = useApp((s) => s.voiceStatus === 'connected')

  return (
    <div className="stage-controls">
      <button className={muted ? 'round-btn off' : 'round-btn'} title={muted ? t('voice.unmute') : t('voice.mute')} onClick={toggleMute}>
        {muted ? <MicOffIcon /> : <MicIcon />}
      </button>
      <button className={deafened ? 'round-btn off' : 'round-btn'} title={deafened ? t('voice.undeafen') : t('voice.deafen')} onClick={toggleDeafen}>
        {deafened ? <HeadphonesOffIcon /> : <HeadphonesIcon />}
      </button>
      <button
        className={camera ? 'round-btn on' : 'round-btn'}
        disabled={!connected}
        title={camera ? t('stage.cameraOff') : t('stage.cameraOn')}
        onClick={() => void toggleCamera()}
      >
        {camera ? <CameraIcon /> : <CameraOffIcon />}
      </button>
      {CAN_SHARE_SCREEN && (
        <button
          className={screen ? 'round-btn on' : 'round-btn'}
          disabled={!connected}
          title={screen ? t('stage.stopShare') : t('stage.shareScreen')}
          onClick={() => (screen ? void stopScreenShare() : openScreenPicker())}
        >
          {screen ? <ScreenOffIcon /> : <ScreenIcon />}
        </button>
      )}
      <button className="round-btn leave" title={t('voice.leave')} onClick={() => void leaveVoice()}>
        <PhoneOffIcon />
      </button>
    </div>
  )
}
