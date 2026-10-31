/** Локальные настройки голоса (хранятся в localStorage этого профиля). */
import type { PttBinding } from '../../../preload/api'

export type VoiceMode = 'voice' | 'ptt'
export type NotifyMode = 'all' | 'mentions' | 'none'

export type ScreenQuality = '720p30' | '720p60' | '1080p30' | '1080p60' | '1440p30' | '1440p60'
/** detail — текст и код (чёткость важнее плавности); motion — игры и видео. */
export type ScreenContent = 'detail' | 'motion'

export interface ScreenPreset {
  width: number
  height: number
  fps: number
  /** Максимальный битрейт верхнего слоя, бит/с. */
  bitrate: number
}

export const SCREEN_PRESETS: Record<ScreenQuality, ScreenPreset> = {
  '720p30': { width: 1280, height: 720, fps: 30, bitrate: 2_000_000 },
  '720p60': { width: 1280, height: 720, fps: 60, bitrate: 3_000_000 },
  '1080p30': { width: 1920, height: 1080, fps: 30, bitrate: 3_500_000 },
  '1080p60': { width: 1920, height: 1080, fps: 60, bitrate: 5_500_000 },
  '1440p30': { width: 2560, height: 1440, fps: 30, bitrate: 6_000_000 },
  '1440p60': { width: 2560, height: 1440, fps: 60, bitrate: 9_000_000 }
}

export interface VoiceSettings {
  inputDeviceId: string
  outputDeviceId: string
  echoCancellation: boolean
  noiseSuppression: boolean
  autoGainControl: boolean
  mode: VoiceMode
  pttBinding: PttBinding | null
  /** Задержка отпускания PTT, мс: не обрезает конец фразы. */
  pttReleaseMs: number
  /** Громкость участников 0…2 (по id пользователя; больше 1 — усиление). */
  userVolumes: Record<string, number>
  /** Громкость звука демонстрации экрана 0…2 (по id ведущего). */
  streamVolumes: Record<string, number>
  sounds: boolean
  videoInputDeviceId: string
  screenQuality: ScreenQuality
  screenContent: ScreenContent
  screenAudio: boolean
  /** Шумоподавление RNNoise (нейросеть) вместо встроенного в WebRTC. */
  rnnoise: boolean
  /** Уведомления ОС о сообщениях: все, только упоминания, никаких. */
  notifyMode: NotifyMode
  notifySound: boolean
  /** Показывать текст сообщения в уведомлении. */
  notifyPreview: boolean
}

const KEY = 'zvon.voice.v1'

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  inputDeviceId: '',
  outputDeviceId: '',
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  mode: 'voice',
  pttBinding: null,
  pttReleaseMs: 200,
  userVolumes: {},
  streamVolumes: {},
  sounds: true,
  videoInputDeviceId: '',
  screenQuality: '1080p30',
  screenContent: 'detail',
  screenAudio: false,
  rnnoise: false,
  notifyMode: 'mentions',
  notifySound: true,
  notifyPreview: true
}

export function loadVoiceSettings(): VoiceSettings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULT_VOICE_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<VoiceSettings>
    return {
      ...DEFAULT_VOICE_SETTINGS,
      ...parsed,
      userVolumes: { ...(parsed.userVolumes ?? {}) },
      streamVolumes: { ...(parsed.streamVolumes ?? {}) },
      mode: parsed.mode === 'ptt' ? 'ptt' : 'voice',
      screenQuality: parsed.screenQuality && parsed.screenQuality in SCREEN_PRESETS ? parsed.screenQuality : '1080p30',
      screenContent: parsed.screenContent === 'motion' ? 'motion' : 'detail',
      notifyMode: parsed.notifyMode === 'all' || parsed.notifyMode === 'none' ? parsed.notifyMode : 'mentions'
    }
  } catch {
    return { ...DEFAULT_VOICE_SETTINGS }
  }
}

export function saveVoiceSettings(s: VoiceSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* хранилище недоступно — настройки проживут до перезапуска */
  }
}
