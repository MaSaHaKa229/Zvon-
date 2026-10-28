/**
 * Правила брандмауэра Windows для хоста: порт сервера (TCP) и порт медиа (UDP и TCP).
 * Добавление требует прав администратора — Windows покажет запрос UAC.
 * Правила по портам, а не по программе: медиа слушает отдельный процесс mediasoup-worker.exe.
 */
import { execFile } from 'node:child_process'
import type { FirewallStatus } from '../preload/api'
import type { Logger } from '../server/logger'

interface Rule {
  name: string
  protocol: 'TCP' | 'UDP'
  port: number
}

function rules(port: number, rtcPort: number): Rule[] {
  return [
    { name: `Zvon-Server-TCP-${port}`, protocol: 'TCP', port },
    { name: `Zvon-Media-UDP-${rtcPort}`, protocol: 'UDP', port: rtcPort },
    { name: `Zvon-Media-TCP-${rtcPort}`, protocol: 'TCP', port: rtcPort }
  ]
}

function run(file: string, args: string[], timeoutMs = 60_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? Number(err.code) : 1) : 0
      resolve({ code, out: `${stdout}${stderr}` })
    })
  })
}

export class Firewall {
  constructor(private log: Logger) {}

  async check(port: number, rtcPort: number): Promise<FirewallStatus> {
    if (process.platform !== 'win32') return { supported: false, missing: [] }
    const missing: string[] = []
    for (const r of rules(port, rtcPort)) {
      // netsh возвращает 0, если правило с таким именем есть.
      const { code } = await run('netsh', ['advfirewall', 'firewall', 'show', 'rule', `name=${r.name}`], 15_000)
      if (code !== 0) missing.push(`${r.protocol} ${r.port}`)
    }
    return { supported: true, missing }
  }

  /** Добавляет недостающие правила с повышением прав. */
  async add(port: number, rtcPort: number): Promise<FirewallStatus> {
    if (process.platform !== 'win32') return { supported: false, missing: [] }
    const commands = rules(port, rtcPort)
      .map((r) => `netsh advfirewall firewall add rule name=${r.name} dir=in action=allow protocol=${r.protocol} localport=${r.port} profile=any`)
      .join('; ')
    // Имена правил без пробелов и кавычек — команду можно безопасно передать в одинарных кавычках PowerShell.
    const script = `Start-Process -FilePath powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-Command','${commands}'`
    this.log.info('Добавляю правила брандмауэра (запрос UAC)')
    const { code, out } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 120_000)
    if (code !== 0) {
      this.log.warn(`Правила брандмауэра не добавлены (код ${code}): ${out.trim()}`)
      const status = await this.check(port, rtcPort)
      return { ...status, error: /cancel|отмен/i.test(out) ? 'Запрос прав администратора отклонён' : 'Не удалось добавить правила брандмауэра' }
    }
    return this.check(port, rtcPort)
  }
}
