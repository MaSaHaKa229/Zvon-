/**
 * Захват экрана: список экранов и окон с превью для своего окна выбора
 * и обработчик getDisplayMedia, который отдаёт выбранный источник (и звук системы, где ОС позволяет).
 */
import { desktopCapturer, session, shell, systemPreferences } from 'electron'
import type { ScreenAccess, ScreenSource } from '../preload/api'
import type { Logger } from '../server/logger'

interface PendingSelection {
  sourceId: string
  audio: boolean
  at: number
}

const SELECTION_TTL_MS = 30_000

/** Звук системы через loopback: Windows — всегда; macOS — 13+ (ScreenCaptureKit, флаги в index.ts). */
export function systemAudioSupported(): boolean {
  if (process.platform === 'win32') return true
  if (process.platform === 'darwin') {
    const major = Number(process.getSystemVersion().split('.')[0])
    return major >= 13
  }
  return false
}

export class ScreenCapture {
  private pending: PendingSelection | null = null

  constructor(private log: Logger) {}

  install(): void {
    session.defaultSession.setDisplayMediaRequestHandler(
      (_request, callback) => {
        const sel = this.pending
        this.pending = null
        if (!sel || Date.now() - sel.at > SELECTION_TTL_MS) {
          this.log.warn('getDisplayMedia без выбранного источника — отклонено')
          callback({})
          return
        }
        desktopCapturer
          .getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } })
          .then((sources) => {
            const source = sources.find((s) => s.id === sel.sourceId) ?? (sources.length === 1 ? sources[0] : undefined)
            if (!source) {
              this.log.warn(`Источник ${sel.sourceId} больше недоступен`)
              callback({})
              return
            }
            const audio = sel.audio && systemAudioSupported() ? ('loopback' as const) : undefined
            this.log.info(`Демонстрация: «${source.name}»${audio ? ' со звуком системы' : ''}`)
            callback(audio ? { video: source, audio } : { video: source })
          })
          .catch((err) => {
            this.log.error('desktopCapturer.getSources', err)
            callback({})
          })
      },
      // Системное окно выбора не используем — у Zvon своё, с превью.
      { useSystemPicker: false }
    )
  }

  async sources(): Promise<ScreenSource[]> {
    const list = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true
    })
    return list
      .filter((s) => !s.name.startsWith('Zvon — просмотр'))
      .map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.id.startsWith('screen:') ? 'screen' : 'window',
        thumbnail: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
        icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null
      }))
  }

  select(sourceId: string, audio: boolean): void {
    this.pending = { sourceId, audio, at: Date.now() }
  }

  access(): ScreenAccess {
    if (process.platform !== 'darwin') return 'granted'
    const status = systemPreferences.getMediaAccessStatus('screen')
    return status === 'granted' ? 'granted' : status === 'not-determined' ? 'unknown' : 'denied'
  }

  async openSettings(): Promise<void> {
    if (process.platform === 'darwin') {
      await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
    }
  }
}
