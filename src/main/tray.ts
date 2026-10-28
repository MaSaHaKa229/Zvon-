/**
 * Значок в трее: открыть окно, быстро выключить микрофон/звук, выйти из голоса, закрыть приложение.
 * Значок меняется, когда есть непрочитанные упоминания.
 */
import { app, Menu, nativeImage, Tray, type NativeImage } from 'electron'
import trayTemplate from '../../resources/trayTemplate.png?asset'
import trayTemplate2x from '../../resources/trayTemplate@2x.png?asset'
import tray16 from '../../resources/tray-16.png?asset'
import tray32 from '../../resources/tray-32.png?asset'
import trayUnread16 from '../../resources/tray-unread-16.png?asset'
import trayUnread32 from '../../resources/tray-unread-32.png?asset'
import type { TrayAction, TrayState } from '../preload/api'
import type { Logger } from '../server/logger'

function icon(small: string, large: string): NativeImage {
  const img = nativeImage.createFromPath(small)
  img.addRepresentation({ scaleFactor: 2, buffer: nativeImage.createFromPath(large).toPNG() })
  return img
}

export class TrayController {
  private tray: Tray | null = null
  private state: TrayState = { inVoice: false, muted: false, deafened: false, unread: 0, mentions: 0, voiceChannel: null }
  private normal: NativeImage
  private unread: NativeImage

  constructor(
    private log: Logger,
    private handlers: { show(): void; quit(): void; action(a: TrayAction): void }
  ) {
    if (process.platform === 'darwin') {
      this.normal = icon(trayTemplate, trayTemplate2x)
      this.normal.setTemplateImage(true)
      this.unread = this.normal
    } else if (process.platform === 'win32') {
      this.normal = icon(tray16, tray32)
      this.unread = icon(trayUnread16, trayUnread32)
    } else {
      this.normal = nativeImage.createFromPath(tray32)
      this.unread = nativeImage.createFromPath(trayUnread32)
    }
  }

  create(): void {
    if (this.tray) return
    try {
      this.tray = new Tray(this.normal)
      this.tray.setToolTip('Zvon')
      // На Windows и Linux клик по значку открывает окно; на macOS — меню.
      this.tray.on('click', () => {
        if (process.platform !== 'darwin') this.handlers.show()
      })
      this.render()
    } catch (err) {
      // Например, в окружении Linux без области уведомлений.
      this.log.warn('Не удалось создать значок в трее', err)
      this.tray = null
    }
  }

  get available(): boolean {
    return this.tray !== null
  }

  update(state: TrayState): void {
    this.state = state
    this.render()
  }

  notify(title: string, content: string): void {
    if (process.platform === 'win32' && this.tray) this.tray.displayBalloon({ title, content, iconType: 'info' })
  }

  private render(): void {
    if (!this.tray) return
    const s = this.state
    this.tray.setImage(s.mentions > 0 ? this.unread : this.normal)
    if (process.platform === 'darwin') this.tray.setTitle(s.mentions > 0 ? String(s.mentions) : '')
    app.setBadgeCount(s.mentions)
    const status = s.inVoice ? `В голосе: ${s.voiceChannel ?? ''}` : 'Не в голосовом канале'
    this.tray.setToolTip(`Zvon — ${status}${s.mentions ? ` · упоминаний: ${s.mentions}` : ''}`)
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Открыть Zvon', click: () => this.handlers.show() },
        { label: status, enabled: false },
        { type: 'separator' },
        {
          label: 'Выключить микрофон',
          type: 'checkbox',
          checked: s.muted,
          click: () => this.handlers.action('toggle-mute')
        },
        {
          label: 'Выключить звук',
          type: 'checkbox',
          checked: s.deafened,
          click: () => this.handlers.action('toggle-deafen')
        },
        { label: 'Отключиться от голоса', enabled: s.inVoice, click: () => this.handlers.action('leave-voice') },
        { type: 'separator' },
        { label: 'Выйти из Zvon', click: () => this.handlers.quit() }
      ])
    )
  }

  destroy(): void {
    this.tray?.destroy()
    this.tray = null
  }
}
