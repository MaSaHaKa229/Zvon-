/**
 * Автозапуск при входе в систему.
 * Windows и macOS — средствами Electron; Linux — файл ~/.config/autostart/zvon.desktop.
 */
import { app } from 'electron'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Logger } from '../server/logger'

export const HIDDEN_ARG = '--hidden'

function linuxDesktopPath(profile: string | null): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(base, 'autostart', profile ? `zvon-${profile}.desktop` : 'zvon.desktop')
}

export function setAutostart(enabled: boolean, profile: string | null, log: Logger): void {
  const args = [HIDDEN_ARG, ...(profile ? [`--profile=${profile}`] : [])]
  try {
    if (process.platform === 'linux') {
      const file = linuxDesktopPath(profile)
      if (!enabled) {
        if (existsSync(file)) unlinkSync(file)
        return
      }
      // У AppImage путь к исполняемому файлу — в переменной APPIMAGE.
      const exec = process.env.APPIMAGE || process.execPath
      const quoted = `"${exec.replace(/"/g, '\\"')}"`
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(
        file,
        ['[Desktop Entry]', 'Type=Application', 'Name=Zvon', `Exec=${quoted} ${args.join(' ')}`, 'X-GNOME-Autostart-enabled=true', 'Terminal=false', ''].join(
          '\n'
        )
      )
      return
    }
    app.setLoginItemSettings({ openAtLogin: enabled, args, openAsHidden: enabled })
  } catch (err) {
    log.error('Не удалось изменить автозапуск', err)
    throw new Error('Не удалось изменить автозапуск')
  }
}

export function launchedHidden(): boolean {
  if (process.argv.includes(HIDDEN_ARG)) return true
  if (process.platform === 'darwin') return app.getLoginItemSettings().wasOpenedAsHidden
  return false
}
