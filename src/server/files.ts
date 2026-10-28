/**
 * Файлы на хосте: загрузка потоком с лимитом размера, раздача с поддержкой Range
 * (перемотка видео), удаление и очистка «сирот» — файлов, которые загрузили, но не отправили.
 *
 * HTTP-API (все ответы с CORS, авторизация — токен из hello: ?t=… или Authorization: Bearer …):
 *   PUT    /upload?name=&type=&width=&height=&duration=[&thumbOf=id][&purpose=avatar]  — тело запроса = файл
 *   GET    /files/:id[?download=1]  — раздача (Range, HEAD)
 *   DELETE /files/:id               — удалить свой ещё не отправленный файл
 */
import { randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { rename, rm, stat, statfs, unlink } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { LIMITS } from '../shared/constants'
import type { FileInfo, FileKind } from '../shared/types'
import type { ServerConfig } from './config'
import { publicFile, type StoredFile, type ZvonDb } from './db'
import type { Logger } from './logger'

const MB = 1024 * 1024
const TOKEN_TTL_MS = 24 * 3600 * 1000
const ORPHAN_AGE_MS = 6 * 3600 * 1000
const CLEANUP_INTERVAL_MS = 3600 * 1000
/** Сколько места должно остаться на диске хоста после загрузки. */
const DISK_RESERVE_BYTES = 500 * MB

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Range',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
  'Access-Control-Max-Age': '600'
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.end()
    return
  }
  const payload = JSON.stringify(body)
  res.writeHead(status, { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

/** Имя файла без путей и служебных символов. */
export function sanitizeName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? ''
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').trim().slice(0, LIMITS.fileNameLength)
  return clean && clean !== '.' && clean !== '..' ? clean : 'file'
}

export function sanitizeMime(raw: string | undefined | null): string {
  const m = (raw ?? '').split(';')[0].trim().toLowerCase()
  return /^[a-z0-9][\w.+-]*\/[\w.+-]+$/.test(m) && m.length <= 100 ? m : 'application/octet-stream'
}

export function kindFor(mime: string): FileKind {
  if (mime === 'image/svg+xml') return 'file' // SVG может содержать скрипты — только как файл
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  return 'file'
}

function intParam(v: string | null, max: number): number | null {
  if (v === null || v === '') return null
  const n = Math.round(Number(v))
  return Number.isFinite(n) && n > 0 && n <= max ? n : null
}

function contentDisposition(name: string, inline: boolean): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

export class FileService {
  private tokens = new Map<string, { userId: string; expires: number }>()
  private cleanupTimer: NodeJS.Timeout | null = null
  readonly dir: string

  constructor(
    private db: ZvonDb,
    private cfg: ServerConfig,
    private log: Logger
  ) {
    this.dir = join(cfg.dataDir, 'files')
  }

  get maxUploadBytes(): number {
    return this.cfg.maxUploadMb * MB
  }

  start(): void {
    mkdirSync(this.dir, { recursive: true })
    this.removeStaleParts()
    void this.cleanup()
    this.cleanupTimer = setInterval(() => void this.cleanup(), CLEANUP_INTERVAL_MS)
  }

  stop(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer)
  }

  /* ======================= токены ======================= */

  issueToken(userId: string): string {
    const token = randomBytes(24).toString('hex')
    this.tokens.set(token, { userId, expires: Date.now() + TOKEN_TTL_MS })
    return token
  }

  private userFor(req: IncomingMessage, url: URL): string | null {
    const header = req.headers.authorization
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : url.searchParams.get('t')
    if (!token) return null
    const entry = this.tokens.get(token)
    if (!entry) return null
    if (entry.expires < Date.now()) {
      this.tokens.delete(token)
      return null
    }
    return entry.userId
  }

  /* ======================= диск ======================= */

  private pathFor(id: string): string {
    return join(this.dir, id.slice(0, 2), id)
  }

  /** Удаляет файлы с диска (записи в БД уже удалены). */
  removeFromDisk(files: StoredFile[]): void {
    for (const f of files) {
      unlink(this.pathFor(f.id)).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') this.log.warn(`Не удалось удалить файл ${f.id}`, err)
      })
    }
  }

  deleteIds(ids: string[]): void {
    this.removeFromDisk(this.db.deleteFiles(ids))
  }

  private removeStaleParts(): void {
    try {
      for (const sub of readdirSync(this.dir)) {
        const subdir = join(this.dir, sub)
        if (!statSync(subdir).isDirectory()) continue
        for (const name of readdirSync(subdir)) {
          if (name.endsWith('.part')) void rm(join(subdir, name), { force: true })
        }
      }
    } catch (err) {
      this.log.warn('Не удалось очистить незавершённые загрузки', err)
    }
  }

  private async cleanup(): Promise<void> {
    try {
      const cutoff = Date.now() - ORPHAN_AGE_MS
      const ids = [...this.db.orphanFiles(cutoff), ...this.db.danglingThumbs(cutoff)]
      if (ids.length) {
        this.deleteIds(ids)
        this.log.info(`Удалено неотправленных файлов: ${ids.length}`)
      }
      for (const [token, entry] of this.tokens) if (entry.expires < Date.now()) this.tokens.delete(token)
    } catch (err) {
      this.log.warn('Ошибка очистки файлов', err)
    }
  }

  /* ======================= HTTP ======================= */

  /** true — запрос обработан этим сервисом. */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    const isUpload = url.pathname === '/upload'
    const fileMatch = /^\/files\/([0-9a-f]{32})(?:\/[^/]*)?$/.exec(url.pathname)
    if (!isUpload && !fileMatch) return false

    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS)
      res.end()
      return true
    }
    const userId = this.userFor(req, url)
    if (!userId) {
      req.resume()
      sendJson(res, 401, { error: 'Нужна авторизация. Переподключитесь к серверу.' })
      return true
    }

    const run = async (): Promise<void> => {
      if (isUpload && req.method === 'PUT') await this.upload(req, res, url, userId)
      else if (fileMatch && (req.method === 'GET' || req.method === 'HEAD')) await this.serve(req, res, url, fileMatch[1])
      else if (fileMatch && req.method === 'DELETE') this.remove(res, fileMatch[1], userId)
      else throw new HttpError(405, 'Метод не поддерживается')
    }
    run().catch((err) => {
      if (err instanceof HttpError) sendJson(res, err.status, { error: err.message })
      else {
        this.log.error(`Ошибка ${req.method} ${url.pathname}`, err)
        sendJson(res, 500, { error: 'Внутренняя ошибка сервера' })
      }
    })
    return true
  }

  private async upload(req: IncomingMessage, res: ServerResponse, url: URL, userId: string): Promise<void> {
    const q = url.searchParams
    const purpose = q.get('purpose') === 'avatar' ? 'avatar' : null
    const thumbOf = q.get('thumbOf')
    const name = sanitizeName(q.get('name') ?? 'file')
    const mime = sanitizeMime(q.get('type') ?? req.headers['content-type'])

    let limit = this.maxUploadBytes
    let parent: StoredFile | null = null
    if (purpose === 'avatar') {
      limit = LIMITS.avatarBytes
      if (!/^image\/(png|jpeg|webp|gif)$/.test(mime)) throw new HttpError(415, 'Аватарка должна быть картинкой PNG, JPEG, WebP или GIF')
    } else if (thumbOf) {
      limit = LIMITS.thumbBytes
      if (!/^[0-9a-f]{32}$/.test(thumbOf)) throw new HttpError(400, 'Неверный thumbOf')
      parent = this.db.getFile(thumbOf)
      if (!parent || parent.uploaderId !== userId) throw new HttpError(404, 'Исходный файл не найден')
      if (!mime.startsWith('image/') || mime === 'image/svg+xml') throw new HttpError(415, 'Миниатюра должна быть картинкой')
    }

    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > limit) {
      req.resume()
      throw new HttpError(413, `Файл больше допустимого: ${Math.floor(limit / MB)} МБ`)
    }
    try {
      const fsInfo = await statfs(this.dir)
      const free = fsInfo.bavail * fsInfo.bsize
      if (free < (Number.isFinite(declared) ? declared : 0) + DISK_RESERVE_BYTES) {
        req.resume()
        throw new HttpError(507, 'На диске хоста заканчивается место')
      }
    } catch (err) {
      if (err instanceof HttpError) throw err
      // statfs недоступен — продолжаем без проверки
    }

    const id = randomBytes(16).toString('hex')
    const finalPath = this.pathFor(id)
    const tmpPath = `${finalPath}.part`
    mkdirSync(dirname(finalPath), { recursive: true })

    let size = 0
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length
        if (size > limit) cb(new HttpError(413, `Файл больше допустимого: ${Math.floor(limit / MB)} МБ`))
        else cb(null, chunk)
      }
    })
    try {
      await pipeline(req, counter, createWriteStream(tmpPath))
    } catch (err) {
      await rm(tmpPath, { force: true })
      if (err instanceof HttpError) throw err
      // Клиент оборвал загрузку — отвечать уже некому.
      this.log.info(`Загрузка «${name}» прервана: ${(err as Error).message}`)
      if (!res.writableEnded) res.destroy()
      return
    }
    if (size === 0) {
      await rm(tmpPath, { force: true })
      throw new HttpError(400, 'Пустой файл')
    }
    await rename(tmpPath, finalPath)

    const kind: FileKind = purpose === 'avatar' ? 'avatar' : thumbOf ? 'image' : kindFor(mime)
    const stored = this.db.insertFile({
      id,
      name,
      mime,
      size,
      kind,
      width: intParam(q.get('width'), 20000),
      height: intParam(q.get('height'), 20000),
      duration: (() => {
        const d = Number(q.get('duration'))
        return Number.isFinite(d) && d > 0 && d < 1e7 ? d : null
      })(),
      isThumb: Boolean(thumbOf),
      uploaderId: userId
    })
    if (parent) this.db.setThumb(parent.id, id)
    this.log.info(`Загружен файл «${name}» (${(size / MB).toFixed(1)} МБ, ${kind}) от ${userId}`)
    sendJson(res, 200, { file: publicFile(stored) satisfies FileInfo })
  }

  private async serve(req: IncomingMessage, res: ServerResponse, url: URL, id: string): Promise<void> {
    const f = this.db.getFile(id)
    if (!f) throw new HttpError(404, 'Файл не найден')
    const path = this.pathFor(id)
    let total: number
    try {
      total = (await stat(path)).size
    } catch {
      throw new HttpError(404, 'Файл отсутствует на диске хоста')
    }

    const inline = url.searchParams.get('download') !== '1' && f.kind !== 'file'
    const headers: Record<string, string | number> = {
      ...CORS,
      'Content-Type': inline ? f.mime : 'application/octet-stream',
      'Content-Disposition': contentDisposition(f.name, inline),
      'X-Content-Type-Options': 'nosniff',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=31536000, immutable'
    }

    let start = 0
    let end = total - 1
    let status = 200
    const range = req.headers.range
    if (range && total > 0) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
      if (!m || (m[1] === '' && m[2] === '')) {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${total}` })
        res.end()
        return
      }
      if (m[1] === '') {
        start = Math.max(0, total - Number(m[2]))
      } else {
        start = Number(m[1])
        end = m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1)
      }
      if (start > end || start >= total) {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${total}` })
        res.end()
        return
      }
      status = 206
      headers['Content-Range'] = `bytes ${start}-${end}/${total}`
    }
    headers['Content-Length'] = total === 0 ? 0 : end - start + 1
    res.writeHead(status, headers)
    if (req.method === 'HEAD' || total === 0) {
      res.end()
      return
    }
    const stream = createReadStream(path, { start, end })
    stream.on('error', (err) => {
      this.log.warn(`Ошибка чтения файла ${id}`, err)
      res.destroy()
    })
    res.on('close', () => stream.destroy())
    stream.pipe(res)
  }

  private remove(res: ServerResponse, id: string, userId: string): void {
    const f = this.db.getFile(id)
    if (!f) throw new HttpError(404, 'Файл не найден')
    if (f.uploaderId !== userId) throw new HttpError(403, 'Это не ваш файл')
    if (f.messageId !== null) throw new HttpError(409, 'Файл уже отправлен — удалите сообщение')
    this.deleteIds([id])
    res.writeHead(204, CORS)
    res.end()
  }

  /** Существует ли файл на диске (для проверок аватарок). */
  exists(id: string): boolean {
    return existsSync(this.pathFor(id))
  }
}
