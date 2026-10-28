/**
 * Простой логгер без зависимостей: пишет в консоль и в файл с ротацией по размеру.
 * Используется и main-процессом, и сервером хоста.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const MAX_FILE_BYTES = 5 * 1024 * 1024

export interface Logger {
  debug(msg: string, extra?: unknown): void
  info(msg: string, extra?: unknown): void
  warn(msg: string, extra?: unknown): void
  error(msg: string, extra?: unknown): void
  child(scope: string): Logger
}

interface Sink {
  file: string | null
  minLevel: LogLevel
}

function formatExtra(extra: unknown): string {
  if (extra === undefined) return ''
  if (extra instanceof Error) return ` ${extra.stack ?? extra.message}`
  try {
    return ' ' + JSON.stringify(extra)
  } catch {
    return ' ' + String(extra)
  }
}

function rotateIfNeeded(file: string): void {
  try {
    if (!existsSync(file)) return
    if (statSync(file).size < MAX_FILE_BYTES) return
    const old = file + '.1'
    if (existsSync(old)) unlinkSync(old)
    renameSync(file, old)
  } catch {
    /* ротация не критична */
  }
}

function makeLogger(sink: Sink, scope: string): Logger {
  const write = (level: LogLevel, msg: string, extra?: unknown): void => {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[sink.minLevel]) return
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${formatExtra(extra)}`
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
    if (sink.file) {
      try {
        rotateIfNeeded(sink.file)
        appendFileSync(sink.file, line + '\n')
      } catch {
        /* если диск недоступен — остаётся консоль */
      }
    }
  }
  return {
    debug: (m, e) => write('debug', m, e),
    info: (m, e) => write('info', m, e),
    warn: (m, e) => write('warn', m, e),
    error: (m, e) => write('error', m, e),
    child: (sub) => makeLogger(sink, `${scope}:${sub}`)
  }
}

export function createLogger(scope: string, file: string | null, minLevel: LogLevel = 'info'): Logger {
  if (file) {
    try {
      mkdirSync(dirname(file), { recursive: true })
    } catch {
      file = null
    }
  }
  const envLevel = process.env.ZVON_LOG_LEVEL as LogLevel | undefined
  return makeLogger({ file, minLevel: envLevel && envLevel in LEVEL_WEIGHT ? envLevel : minLevel }, scope)
}
