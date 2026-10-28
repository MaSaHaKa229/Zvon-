import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Channel, VoiceState } from '../../../shared/types'
import { useApp } from '../store/app'
import {
  joinVoice,
  leaveVoice,
  openScreenPicker,
  setUserVolume,
  showVoiceView,
  stopScreenShare,
  toggleCamera,
  toggleDeafen,
  toggleMute
} from '../store/voice'
import { Avatar } from './Common'
import {
  CameraIcon,
  CameraOffIcon,
  FocusIcon,
  GearIcon,
  HeadphonesIcon,
  HeadphonesOffIcon,
  MicIcon,
  MicOffIcon,
  PhoneOffIcon,
  ScreenIcon,
  ScreenOffIcon,
  SignalIcon,
  VolumeIcon
} from './Icons'
import { ScreenPicker } from './ScreenPicker'
import { VoiceSettingsDialog } from './VoiceSettings'

const EMPTY_LEVELS: Record<string, number> = {}

/** Голосовой канал в списке слева вместе с участниками. */
export function VoiceChannelItem({ channel }: { channel: Channel }) {
  const { t } = useTranslation()
  const voiceStates = useApp((s) => s.voiceStates)
  const levels = useApp((s) => s.speaking[channel.id]) ?? EMPTY_LEVELS
  const myChannel = useApp((s) => s.voiceChannelId)
  const serverVoiceError = useApp((s) => s.serverVoiceError)
  const members = useMemo(
    () => Object.values(voiceStates).filter((v) => v.channelId === channel.id).sort((a, b) => a.joinedAt - b.joinedAt),
    [voiceStates, channel.id]
  )
  const here = myChannel === channel.id

  return (
    <div className="voice-channel">
      <button
        className={here ? 'channel channel-voice active' : 'channel channel-voice'}
        onClick={() => void joinVoice(channel.id)}
        title={serverVoiceError ? t('voice.serverUnavailable', { reason: serverVoiceError }) : channel.name}
      >
        <VolumeIcon width={18} height={18} />
        <span className="channel-name">{channel.name}</span>
        {members.length > 0 && <span className="voice-count">{members.length}</span>}
      </button>
      {members.length > 0 && (
        <div className="voice-members">
          {members.map((m) => (
            <VoiceMember key={m.userId} state={m} speaking={levels[m.userId] !== undefined} />
          ))}
        </div>
      )}
    </div>
  )
}

function VoiceMember({ state, speaking }: { state: VoiceState; speaking: boolean }) {
  const { t } = useTranslation()
  const user = useApp((s) => s.users[state.userId])
  const myId = useApp((s) => s.me?.id)
  const volume = useApp((s) => s.voiceSettings.userVolumes[state.userId] ?? 1)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const isMe = state.userId === myId
  const name = user?.nickname ?? '…'

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const silenced = !isMe && volume === 0
  return (
    <div className="voice-member-wrap" ref={ref}>
      <button
        className={['voice-member', speaking && !state.muted ? 'speaking' : '', isMe ? 'me' : ''].join(' ')}
        onClick={() => !isMe && setOpen((v) => !v)}
        title={speaking ? t('voice.speakingNow') : name}
      >
        <span className="voice-avatar">
          <Avatar id={state.userId} nickname={name} size={24} />
        </span>
        <span className={silenced ? 'voice-name silenced' : 'voice-name'}>{name}</span>
        {state.deafened ? (
          <HeadphonesOffIcon width={14} height={14} className="voice-flag" />
        ) : state.muted ? (
          <MicOffIcon width={14} height={14} className="voice-flag" />
        ) : null}
      </button>
      {open && (
        <div className="volume-popover" onMouseDown={(e) => e.stopPropagation()}>
          <div className="volume-title">{name}</div>
          <label className="volume-label">
            {t('voice.volume', { value: Math.round(volume * 100) })}
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={Math.round(volume * 100)}
              onChange={(e) => setUserVolume(state.userId, Number(e.target.value) / 100)}
            />
          </label>
          <button className="btn btn-small btn-secondary" onClick={() => setUserVolume(state.userId, volume === 0 ? 1 : 0)}>
            {volume === 0 ? t('voice.localUnmute') : t('voice.localMute')}
          </button>
        </div>
      )}
    </div>
  )
}

/** Панель над профилем: статус голосового подключения. */
export function VoicePanel() {
  const { t } = useTranslation()
  const channelId = useApp((s) => s.voiceChannelId)
  const status = useApp((s) => s.voiceStatus)
  const error = useApp((s) => s.voiceError)
  const micError = useApp((s) => s.micError)
  const channels = useApp((s) => s.channels)
  const settings = useApp((s) => s.voiceSettings)
  const pttPressed = useApp((s) => s.pttPressed)
  const serverName = useApp((s) => s.serverName)
  const camera = useApp((s) => s.localMedia.camera)
  const screen = useApp((s) => s.localMedia.screen)
  const mediaError = useApp((s) => s.mediaError)
  const pickerOpen = useApp((s) => s.screenPickerOpen)
  const stageShown = useApp((s) => s.mainView === 'voice')

  if (!channelId && status !== 'error') return null
  const channel = channels.find((c) => c.id === channelId)
  const label =
    status === 'connected'
      ? t('voice.connected')
      : status === 'connecting'
        ? t('voice.connecting')
        : status === 'reconnecting'
          ? t('voice.reconnecting')
          : t('voice.error')

  return (
    <div className="voice-panel">
      <div className="voice-panel-row">
        <SignalIcon width={18} height={18} className={`voice-signal ${status}`} />
        <div className="voice-panel-text">
          <div className={`voice-status ${status}`}>{label}</div>
          <div className="voice-where">{channel ? `${channel.name} / ${serverName}` : (error ?? '')}</div>
        </div>
        {channelId && (
          <button className="icon-btn danger" title={t('voice.leave')} onClick={() => void leaveVoice()}>
            <PhoneOffIcon width={18} height={18} />
          </button>
        )}
      </div>
      {status === 'error' && error && channel && <div className="voice-warning">{error}</div>}
      {micError && <div className="voice-warning">{micError}</div>}
      {mediaError && !stageShown && <div className="voice-warning">{mediaError}</div>}
      {channelId && status === 'connected' && (
        <div className="voice-panel-buttons">
          <button className={camera ? 'panel-btn on' : 'panel-btn'} title={camera ? t('stage.cameraOff') : t('stage.cameraOn')} onClick={() => void toggleCamera()}>
            {camera ? <CameraIcon width={18} height={18} /> : <CameraOffIcon width={18} height={18} />}
          </button>
          <button
            className={screen ? 'panel-btn on' : 'panel-btn'}
            title={screen ? t('stage.stopShare') : t('stage.shareScreen')}
            onClick={() => (screen ? void stopScreenShare() : openScreenPicker())}
          >
            {screen ? <ScreenOffIcon width={18} height={18} /> : <ScreenIcon width={18} height={18} />}
          </button>
          <button className="panel-btn" title={t('stage.openStage')} onClick={showVoiceView}>
            <FocusIcon width={18} height={18} />
          </button>
        </div>
      )}
      {pickerOpen && !stageShown && <ScreenPicker />}
      {channelId && settings.mode === 'ptt' && (
        <div className={pttPressed ? 'ptt-hint active' : 'ptt-hint'}>
          {settings.pttBinding ? t('voice.pttHint', { key: settings.pttBinding.label }) : t('voice.pttNoKey')}
        </div>
      )}
    </div>
  )
}

/** Кнопки микрофона, звука и настроек в панели профиля. */
export function VoiceControls() {
  const { t } = useTranslation()
  const muted = useApp((s) => s.selfMuted)
  const deafened = useApp((s) => s.selfDeafened)
  const [settingsOpen, setSettingsOpen] = useState(false)
  return (
    <>
      <button className={muted ? 'icon-btn toggled-off' : 'icon-btn'} title={muted ? t('voice.unmute') : t('voice.mute')} onClick={toggleMute}>
        {muted ? <MicOffIcon width={18} height={18} /> : <MicIcon width={18} height={18} />}
      </button>
      <button
        className={deafened ? 'icon-btn toggled-off' : 'icon-btn'}
        title={deafened ? t('voice.undeafen') : t('voice.deafen')}
        onClick={toggleDeafen}
      >
        {deafened ? <HeadphonesOffIcon width={18} height={18} /> : <HeadphonesIcon width={18} height={18} />}
      </button>
      <button className="icon-btn" title={t('voice.settings')} onClick={() => setSettingsOpen(true)}>
        <GearIcon width={18} height={18} />
      </button>
      {settingsOpen && <VoiceSettingsDialog onClose={() => setSettingsOpen(false)} />}
    </>
  )
}
