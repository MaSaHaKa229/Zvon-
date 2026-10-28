import { app, BrowserWindow, clipboard, ipcMain, session, shell, systemPreferences } from 'electron'
import { X509Certificate } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_RTC_PORT, LIMITS } from '../shared/constants'
import type { AppSettings, HostSettings, InitialState, ProbeResult, PttBinding, TrayState } from '../preload/api'
import appIcon from '../../resources/icon.png?asset'
import { launchedHidden, setAutostart } from './autostart'
import { Firewall } from './firewall'
import { TrayController } from './tray'
import { createLogger } from '../server/logger'
import { HostController } from './hostProcess'
import { probeServer } from './probe'
import { PushToTalk } from './ptt'
import { ScreenCapture, systemAudioSupported } from './screen'
import { SettingsStore } from './store'

/* ---------- профиль: позволяет запустить несколько клиентов на одной машине ---------- */

function readProfile(): string | null {
  const arg = process.argv.find((a) => a.startsWith('--profile='))
  const raw = arg ? arg.slice('--profile='.length) : process.env.ZVON_PROFILE
  if (!raw) return null
  const clean = raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32)
  return clean || null
}

/* ---------- флаги Chromium для захвата экрана (до готовности приложения) ---------- */

const features: string[] = []
if (process.platform === 'linux') {
  // Wayland: захват через PipeWire / xdg-desktop-portal; ozone сам выберет Wayland или X11.
  features.push('WebRTCPipeWireCapturer')
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto')
}
if (process.platform === 'darwin') {
  // macOS 13+: звук системы при демонстрации через ScreenCaptureKit.
  features.push('MacLoopbackAudioForScreenShare', 'MacSckSystemAudioLoopbackOverride')
}
if (features.length) app.commandLine.appendSwitch('enable-features', features.join(','))

const profile = readProfile()
// Нужен Windows для системных уведомлений от имени приложения.
if (process.platform === 'win32') app.setAppUserModelId(profile ? `com.zvon.app.${profile}` : 'com.zvon.app')
if (profile) {
  app.setPath('userData', join(app.getPath('appData'), `Zvon-${profile}`))
}

const userData = app.getPath('userData')
const log = createLogger('main', join(userData, 'logs', 'main.log'))
log.info(`Zvon ${app.getVersion()} запускается, профиль: ${profile ?? 'по умолчанию'}, userData: ${userData}`)

process.on('uncaughtException', (err) => log.error('Необработанное исключение в main', err))
process.on('unhandledRejection', (reason) => log.error('Необработанный отказ промиса в main', reason))

// Один экземпляр на профиль (блокировка привязана к каталогу userData).
if (!app.requestSingleInstanceLock()) {
  log.info('Приложение уже запущено с этим профилем — передаю фокус и выхожу')
  app.quit()
} else {
  run()
}

/**
 * В собранном приложении mediasoup-worker лежит вне asar (asarUnpack),
 * и mediasoup нужно явно указать путь к нему.
 */
function resolveWorkerBin(): string | null {
  if (!app.isPackaged) return null
  const exe = process.platform === 'win32' ? 'mediasoup-worker.exe' : 'mediasoup-worker'
  const candidate = join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'mediasoup', 'worker', 'out', 'Release', exe)
  if (existsSync(candidate)) return candidate
  log.error(`mediasoup-worker не найден: ${candidate}`)
  return null
}

/** Разрешения, которые нужны интерфейсу; остальные запросы отклоняются. */
const ALLOWED_PERMISSIONS = new Set([
  'media',
  'display-capture',
  'notifications',
  'clipboard-sanitized-write',
  'fullscreen',
  'speaker-selection'
])

/** Окно просмотра демонстрации (about:blank, наполняется из основного окна). */
const POPOUT_PREFIX = 'zvon-popout'

function run(): void {
  const store = new SettingsStore(userData, log.child('settings'))
  const host = new HostController(log.child('host'), join(userData, 'host-data'), store.get().adminToken, resolveWorkerBin())
  let mainWindow: BrowserWindow | null = null
  let quitting = false
  const ptt = new PushToTalk(log.child('ptt'), (pressed) => mainWindow?.webContents.send('ptt:pressed', pressed))
  const screen = new ScreenCapture(log.child('screen'))
  const firewall = new Firewall(log.child('firewall'))
  let trayHintShown = false

  const showWindow = (): void => {
    if (!mainWindow) {
      createWindow(true)
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
  const quitApp = (): void => {
    quitting = true
    app.quit()
  }
  const tray = new TrayController(log.child('tray'), {
    show: showWindow,
    quit: quitApp,
    action: (a) => mainWindow?.webContents.send('tray:action', a)
  })

  host.on('settings', ({ maxUploadMb }: { maxUploadMb: number }) => {
    store.setHostSettings({ ...store.get().host, maxUploadMb })
  })

  host.on('status', (status) => {
    mainWindow?.webContents.send('host:status', status)
    // Своему серверу доверяем автоматически.
    if (status.state === 'running' && status.fingerprint && status.port) {
      store.trust('127.0.0.1', status.port, status.fingerprint)
    }
  })

  function createWindow(show: boolean): void {
    mainWindow = new BrowserWindow({
      icon: appIcon,
      width: 1280,
      height: 820,
      minWidth: 940,
      minHeight: 560,
      show: false,
      backgroundColor: '#1e1f22',
      title: profile ? `Zvon — ${profile}` : 'Zvon',
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: true,
        // Голос должен работать без жестов пользователя и в свёрнутом окне.
        autoplayPolicy: 'no-user-gesture-required',
        backgroundThrottling: false
      }
    })

    mainWindow.once('ready-to-show', () => {
      if (show) mainWindow?.show()
    })
    // Крестик сворачивает в трей (если включено и трей доступен).
    mainWindow.on('close', (e) => {
      if (quitting || !store.get().app.closeToTray || !tray.available) return
      e.preventDefault()
      mainWindow?.hide()
      if (!trayHintShown) {
        trayHintShown = true
        tray.notify('Zvon работает в фоне', 'Голос не прерывается. Открыть или выйти — через значок в трее.')
      }
    })
    mainWindow.on('closed', () => {
      mainWindow = null
    })

    // Все внешние ссылки — в системный браузер.
    mainWindow.webContents.setWindowOpenHandler(({ url, frameName }) => {
      if (url === 'about:blank' && frameName.startsWith(POPOUT_PREFIX)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 1280,
            height: 760,
            minWidth: 320,
            minHeight: 200,
            backgroundColor: '#000000',
            autoHideMenuBar: true,
            title: 'Zvon — просмотр',
            webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
          }
        }
      }
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    mainWindow.webContents.on('will-navigate', (e, url) => {
      const devUrl = process.env.ELECTRON_RENDERER_URL
      if (devUrl && url.startsWith(devUrl)) return
      e.preventDefault()
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    })
    mainWindow.webContents.on('render-process-gone', (_e, details) => {
      log.error(`Renderer упал: ${details.reason} (код ${details.exitCode})`)
    })

    if (process.env.ELECTRON_RENDERER_URL) {
      void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
    } else {
      void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
    }
  }

  /* ---------- TOFU: доверие к самоподписанным сертификатам по отпечатку ---------- */

  function installPermissions(): void {
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      const allowed = ALLOWED_PERMISSIONS.has(permission)
      if (!allowed) log.warn(`Отклонён запрос разрешения: ${permission}`)
      callback(allowed)
    })
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission))
  }

  function installCertificateCheck(): void {
    session.defaultSession.setCertificateVerifyProc((request, callback) => {
      if (request.verificationResult === 'net::OK') {
        callback(-3) // обычный публичный сертификат — решение Chromium
        return
      }
      try {
        const fp = new X509Certificate(request.certificate.data).fingerprint256
        if (store.isTrustedFingerprint(request.hostname, fp)) {
          callback(0)
          return
        }
        log.warn(`Отклонён недоверенный сертификат ${request.hostname} (${fp})`)
      } catch (err) {
        log.warn(`Не удалось разобрать сертификат ${request.hostname}`, err)
      }
      callback(-2)
    })
  }

  /* ---------- IPC ---------- */

  const assertHostPort = (h: unknown, p: unknown): { h: string; p: number } => {
    if (typeof h !== 'string' || !h.trim() || h.length > 255) throw new Error('Неверный адрес хоста')
    const port = Number(p)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Неверный порт')
    return { h: h.trim(), p: port }
  }

  function registerIpc(): void {
    ipcMain.handle('app:initial-state', (): InitialState => {
      const s = store.get()
      return {
        clientId: s.clientId,
        nickname: s.nickname,
        adminToken: s.adminToken,
        recentServers: s.recentServers,
        hostSettings: s.host,
        hostStatus: host.getStatus(),
        platform: process.platform,
        version: app.getVersion(),
        profile,
        systemAudio: systemAudioSupported() ? 'loopback' : process.platform === 'linux' ? 'monitor' : 'none',
        appSettings: s.app,
        trayAvailable: tray.available
      }
    })

    ipcMain.handle('app:set-settings', (_e, raw: unknown) => {
      const patch = (raw ?? {}) as Partial<AppSettings>
      const cur = store.get().app
      const next: AppSettings = {
        closeToTray: typeof patch.closeToTray === 'boolean' ? patch.closeToTray : cur.closeToTray,
        autostart: typeof patch.autostart === 'boolean' ? patch.autostart : cur.autostart,
        startMinimized: typeof patch.startMinimized === 'boolean' ? patch.startMinimized : cur.startMinimized
      }
      if (next.autostart !== cur.autostart) setAutostart(next.autostart, profile, log)
      store.update({ app: next })
      return next
    })

    ipcMain.on('tray:state', (_e, raw: unknown) => {
      const s = raw as TrayState
      if (s && typeof s === 'object') tray.update(s)
    })
    ipcMain.on('app:focus', () => showWindow())
    ipcMain.on('app:attention', () => {
      if (mainWindow && !mainWindow.isFocused()) mainWindow.flashFrame(true)
    })

    const ports = (p: unknown, r: unknown): [number, number] => {
      const a = Number(p)
      const b = Number(r)
      if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < 1 || a > 65535 || b > 65535) throw new Error('Неверные порты')
      return [a, b]
    }
    ipcMain.handle('firewall:check', (_e, p: unknown, r: unknown) => firewall.check(...ports(p, r)))
    ipcMain.handle('firewall:add', (_e, p: unknown, r: unknown) => firewall.add(...ports(p, r)))

    ipcMain.handle('app:set-nickname', (_e, nickname: unknown) => {
      if (typeof nickname !== 'string') throw new Error('Неверный ник')
      store.setNickname(nickname)
    })

    ipcMain.handle('server:probe', async (_e, h: unknown, p: unknown): Promise<ProbeResult> => {
      try {
        const { h: hostName, p: port } = assertHostPort(h, p)
        const res = await probeServer(hostName, port)
        return { ok: true, fingerprint: res.fingerprint, trust: store.trustState(hostName, port, res.fingerprint), health: res.health }
      } catch (err) {
        log.warn('Проверка сервера не удалась', (err as Error).message)
        return { ok: false, error: (err as Error).message }
      }
    })

    ipcMain.handle('server:trust', (_e, h: unknown, p: unknown, fp: unknown) => {
      const { h: hostName, p: port } = assertHostPort(h, p)
      if (typeof fp !== 'string' || !/^[0-9A-F:]{95}$/i.test(fp)) throw new Error('Неверный отпечаток')
      store.trust(hostName, port, fp.toUpperCase())
      log.info(`Добавлено доверие к ${hostName}:${port} (${fp})`)
    })

    ipcMain.handle('server:remember', (_e, h: unknown, p: unknown, name: unknown, password: unknown, adminToken: unknown) => {
      const { h: hostName, p: port } = assertHostPort(h, p)
      return store.rememberServer(
        hostName,
        port,
        typeof name === 'string' ? name.slice(0, LIMITS.serverNameLength) : hostName,
        typeof password === 'string' && password ? password.slice(0, LIMITS.passwordLength) : undefined,
        typeof adminToken === 'string' && adminToken ? adminToken.slice(0, 128) : undefined
      )
    })

    ipcMain.handle('server:forget', (_e, h: unknown, p: unknown) => {
      const { h: hostName, p: port } = assertHostPort(h, p)
      return store.forgetServer(hostName, port)
    })

    ipcMain.handle('host:start', async (_e, raw: unknown) => {
      const r = (raw ?? {}) as Partial<HostSettings>
      const settings: HostSettings = {
        port: Number(r.port),
        rtcPort: Number(r.rtcPort ?? DEFAULT_RTC_PORT),
        maxUploadMb: Number(r.maxUploadMb ?? LIMITS.defaultMaxUploadMb),
        password: typeof r.password === 'string' ? r.password.slice(0, LIMITS.passwordLength) : '',
        serverName: typeof r.serverName === 'string' && r.serverName.trim() ? r.serverName.trim().slice(0, LIMITS.serverNameLength) : 'Сервер друзей'
      }
      if (!Number.isInteger(settings.port) || settings.port < 1024 || settings.port > 65535) {
        throw new Error('Порт должен быть числом от 1024 до 65535')
      }
      if (!Number.isInteger(settings.rtcPort) || settings.rtcPort < 1024 || settings.rtcPort > 65535) {
        throw new Error('Порт голоса должен быть числом от 1024 до 65535')
      }
      if (settings.rtcPort === settings.port) throw new Error('Порт голоса должен отличаться от порта сервера')
      if (!Number.isInteger(settings.maxUploadMb) || settings.maxUploadMb < 1 || settings.maxUploadMb > 10240) {
        throw new Error('Лимит файла должен быть от 1 до 10240 МБ')
      }
      store.setHostSettings(settings)
      return host.start(settings)
    })

    ipcMain.handle('host:stop', () => host.stop())

    ipcMain.handle('app:open-external', (_e, url: unknown) => {
      if (typeof url === 'string' && /^https?:\/\//i.test(url)) return shell.openExternal(url)
      return undefined
    })

    ipcMain.handle('app:copy-text', (_e, text: unknown) => {
      if (typeof text === 'string') clipboard.writeText(text.slice(0, 10_000))
    })

    ipcMain.handle('media:ensure-access', async (_e, kind: unknown) => {
      if (kind !== 'microphone' && kind !== 'camera') return false
      if (process.platform !== 'darwin') return true
      const status = systemPreferences.getMediaAccessStatus(kind)
      if (status === 'granted') return true
      if (status === 'not-determined') return systemPreferences.askForMediaAccess(kind)
      log.warn(`macOS: доступ к ${kind} — ${status}`)
      return false
    })

    ipcMain.handle('ptt:support', () => ptt.support())
    ipcMain.handle('ptt:configure', (_e, enabled: unknown, binding: unknown) => {
      const b = binding as PttBinding | null
      const valid =
        b === null ||
        (typeof b === 'object' &&
          ((b.type === 'dom' && typeof b.code === 'string') || ((b.type === 'key' || b.type === 'mouse') && typeof b.code === 'number')))
      if (!valid) throw new Error('Неверная клавиша PTT')
      return ptt.configure(Boolean(enabled), b)
    })
    ipcMain.handle('ptt:record', () => ptt.record())

    ipcMain.handle('screen:sources', async () => {
      try {
        return await screen.sources()
      } catch (err) {
        log.error('Не удалось получить список экранов', err)
        throw new Error('Не удалось получить список экранов и окон')
      }
    })
    ipcMain.handle('screen:select', (_e, sourceId: unknown, audio: unknown) => {
      if (typeof sourceId !== 'string' || sourceId.length > 200) throw new Error('Неверный источник')
      screen.select(sourceId, audio === true)
    })
    ipcMain.handle('screen:access', () => screen.access())

    // Скачивание файла с хоста: Electron покажет диалог «Сохранить как».
    ipcMain.handle('file:download', (_e, url: unknown) => {
      if (typeof url !== 'string' || !/^https:\/\/[^/]+\/files\/[0-9a-f]{32}/.test(url)) throw new Error('Неверная ссылка на файл')
      mainWindow?.webContents.downloadURL(url)
    })
    ipcMain.handle('screen:open-settings', () => screen.openSettings())
  }

  app.on('second-instance', () => showWindow())

  // Перед выходом корректно останавливаем сервер, чтобы клиенты получили уведомление.
  let hostStopped = false
  app.on('before-quit', (e) => {
    quitting = true
    if (hostStopped || !host.isRunning()) return
    e.preventDefault()
    hostStopped = true
    log.info('Выход: останавливаю сервер хоста')
    host
      .stop('Хост закрыл приложение')
      .catch((err) => log.error('Ошибка остановки сервера при выходе', err))
      .finally(() => app.quit())
  })

  app.on('will-quit', () => {
    ptt.dispose()
    tray.destroy()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && !tray.available) app.quit()
  })

  app.on('activate', () => showWindow())

  app
    .whenReady()
    .then(() => {
      installCertificateCheck()
      installPermissions()
      screen.install()
      registerIpc()
      tray.create()
      // При автозапуске со свёрнутым окном показываем только значок в трее.
      const hidden = launchedHidden() && store.get().app.startMinimized && tray.available
      createWindow(!hidden)
    })
    .catch((err) => {
      log.error('Ошибка запуска приложения', err)
      app.quit()
    })
}
