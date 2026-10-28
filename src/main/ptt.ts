/**
 * Глобальная клавиша push-to-talk через uiohook-napi (работает, даже когда окно Zvon не в фокусе).
 * Перехват клавиатуры запускается только пока PTT включён или идёт запись клавиши.
 */
import { systemPreferences } from 'electron'
import type { PttBinding, PttSupport } from '../preload/api'
import type { Logger } from '../server/logger'

interface HookEvent {
  keycode?: number
  button?: number
}

interface UiohookLike {
  on(event: 'keydown' | 'keyup' | 'mousedown' | 'mouseup', listener: (e: HookEvent) => void): void
  removeAllListeners(event?: string): void
  start(): void
  stop(): void
}

interface UiohookModule {
  uIOhook: UiohookLike
  UiohookKey: Record<string, number>
}

const RECORD_TIMEOUT_MS = 10_000
const ESCAPE_KEYCODE = 1 // UiohookKey.Escape

export class PushToTalk {
  private mod: UiohookModule | null = null
  private loadError: string | null = null
  private loaded = false
  private running = false
  private enabled = false
  private binding: PttBinding | null = null
  private pressed = false
  private recorder: ((b: PttBinding | null) => void) | null = null

  constructor(
    private log: Logger,
    private onChange: (pressed: boolean) => void
  ) {}

  private async load(): Promise<UiohookModule | null> {
    if (this.loaded) return this.mod
    this.loaded = true
    try {
      const m = (await import('uiohook-napi')) as unknown as Partial<UiohookModule> & { default?: UiohookModule }
      const lib = m.uIOhook ? (m as UiohookModule) : m.default
      if (!lib?.uIOhook) throw new Error('модуль загружен, но uIOhook не найден')
      this.mod = lib
      this.mod.uIOhook.on('keydown', (e) => this.onDown('key', e.keycode))
      this.mod.uIOhook.on('keyup', (e) => this.onUp('key', e.keycode))
      this.mod.uIOhook.on('mousedown', (e) => this.onDown('mouse', e.button))
      this.mod.uIOhook.on('mouseup', (e) => this.onUp('mouse', e.button))
      this.log.info('uiohook-napi загружен, глобальная клавиша PTT доступна')
    } catch (err) {
      this.loadError = (err as Error).message
      this.log.warn('uiohook-napi недоступен — PTT только в окне приложения', err)
    }
    return this.mod
  }

  async support(): Promise<PttSupport> {
    const mod = await this.load()
    if (!mod) return { global: false, reason: `Глобальные клавиши недоступны (${this.loadError}). PTT работает, когда окно Zvon активно.` }
    if (process.platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(false)) {
      return {
        global: true,
        reason: 'macOS: разрешите Zvon в «Настройки → Конфиденциальность → Универсальный доступ», иначе клавиша не будет видна вне окна.'
      }
    }
    if (process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland') {
      return {
        global: true,
        reason: 'Wayland: глобальные клавиши видны только над окнами X11. Надёжнее всего, когда окно Zvon активно.'
      }
    }
    return { global: true }
  }

  private label(type: 'key' | 'mouse', code: number): string {
    if (type === 'mouse') return code === 3 ? 'Средняя кнопка мыши' : `Кнопка мыши ${code}`
    const names = this.mod?.UiohookKey ?? {}
    const name = Object.entries(names).find(([, v]) => v === code)?.[0]
    return name ?? `Клавиша ${code}`
  }

  private matches(type: 'key' | 'mouse', code: number | undefined): boolean {
    return Boolean(this.binding && this.binding.type === type && this.binding.code === code)
  }

  private onDown(type: 'key' | 'mouse', code: number | undefined): void {
    if (code === undefined) return
    if (this.recorder) {
      if (type === 'mouse' && code < 3) return // левая/правая кнопки — не годятся для PTT
      const done = this.recorder
      this.recorder = null
      done(type === 'key' && code === ESCAPE_KEYCODE ? null : { type, code, label: this.label(type, code) })
      this.syncRunning()
      return
    }
    if (this.enabled && !this.pressed && this.matches(type, code)) {
      this.pressed = true
      this.onChange(true)
    }
  }

  private onUp(type: 'key' | 'mouse', code: number | undefined): void {
    if (this.enabled && this.pressed && this.matches(type, code)) {
      this.pressed = false
      this.onChange(false)
    }
  }

  private syncRunning(): void {
    const need = Boolean(this.mod && ((this.enabled && this.binding && this.binding.type !== 'dom') || this.recorder))
    if (need && !this.running) {
      try {
        this.mod!.uIOhook.start()
        this.running = true
        this.log.info('Перехват клавиш PTT запущен')
      } catch (err) {
        this.log.error('Не удалось запустить перехват клавиш', err)
      }
    } else if (!need && this.running) {
      try {
        this.mod!.uIOhook.stop()
      } catch (err) {
        this.log.warn('Ошибка остановки перехвата клавиш', err)
      }
      this.running = false
      this.log.info('Перехват клавиш PTT остановлен')
    }
  }

  async configure(enabled: boolean, binding: PttBinding | null): Promise<void> {
    await this.load()
    this.enabled = enabled
    this.binding = binding
    if (!enabled && this.pressed) {
      this.pressed = false
      this.onChange(false)
    }
    if (enabled && process.platform === 'darwin' && binding && binding.type !== 'dom') {
      // Показывает системный запрос, если доступа ещё нет.
      systemPreferences.isTrustedAccessibilityClient(true)
    }
    this.syncRunning()
  }

  /** Ждёт нажатия клавиши или кнопки мыши. Esc — отмена (null). */
  async record(): Promise<PttBinding | null> {
    const mod = await this.load()
    if (!mod) return null
    if (this.recorder) this.recorder(null)
    return new Promise<PttBinding | null>((resolve) => {
      const timer = setTimeout(() => {
        if (this.recorder === finish) {
          this.recorder = null
          this.syncRunning()
          resolve(null)
        }
      }, RECORD_TIMEOUT_MS)
      const finish = (b: PttBinding | null): void => {
        clearTimeout(timer)
        resolve(b)
      }
      this.recorder = finish
      this.syncRunning()
    })
  }

  dispose(): void {
    this.enabled = false
    this.recorder = null
    this.syncRunning()
  }
}
