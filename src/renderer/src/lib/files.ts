/**
 * Работа с файлами хоста: ссылки, загрузка с прогрессом, подготовка миниатюр и метаданных на клиенте.
 * Миниатюры делает клиент (canvas), поэтому серверу не нужны библиотеки обработки изображений.
 */
import type { FileInfo, FileKind } from '../../../shared/types'
import { getApp } from '../store/app'

const THUMB_MAX = 640
const THUMB_QUALITY = 0.82
const META_TIMEOUT_MS = 8_000

export function fileUrl(id: string, opts: { download?: boolean } = {}): string | null {
  const { target, fileToken } = getApp()
  if (!target || !fileToken) return null
  const host = target.host.includes(':') ? `[${target.host}]` : target.host
  return `https://${host}:${target.port}/files/${id}?t=${encodeURIComponent(fileToken)}${opts.download ? '&download=1' : ''}`
}

function uploadUrl(params: Record<string, string | number | null | undefined>): string | null {
  const { target } = getApp()
  if (!target) return null
  const host = target.host.includes(':') ? `[${target.host}]` : target.host
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') q.set(k, String(v))
  return `https://${host}:${target.port}/upload?${q.toString()}`
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} МБ`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} ГБ`
}

export function formatDuration(seconds: number): string {
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

/** Тип файла так же, как его определит сервер (SVG — просто файл). */
export function kindOf(mime: string): Exclude<FileKind, 'avatar'> {
  if (mime === 'image/svg+xml') return 'file'
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  return 'file'
}

/** У некоторых файлов браузер не знает MIME — подсказываем по расширению. */
export function mimeOf(file: File): string {
  if (file.type) return file.type
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    mkv: 'video/x-matroska',
    mov: 'video/quicktime',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    opus: 'audio/ogg',
    flac: 'audio/flac',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    heic: 'image/heic',
    webp: 'image/webp'
  }
  return map[ext] ?? 'application/octet-stream'
}

export interface MediaMeta {
  width: number | null
  height: number | null
  duration: number | null
  thumb: Blob | null
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/webp', THUMB_QUALITY))
}

function drawScaled(source: CanvasImageSource, w: number, h: number): HTMLCanvasElement {
  const scale = Math.min(1, THUMB_MAX / Math.max(w, h))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(w * scale))
  canvas.height = Math.max(1, Math.round(h * scale))
  canvas.getContext('2d')?.drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvas
}

async function imageMeta(file: File, mime: string): Promise<MediaMeta> {
  const bmp = await createImageBitmap(file)
  const { width, height } = bmp
  // GIF показываем оригиналом (миниатюра потеряла бы анимацию); маленьким картинкам миниатюра не нужна.
  const needThumb = mime !== 'image/gif' && (Math.max(width, height) > THUMB_MAX || file.size > 400 * 1024)
  const thumb = needThumb ? await canvasToBlob(drawScaled(bmp, width, height)) : null
  bmp.close()
  return { width, height, duration: null, thumb }
}

function waitEvent(el: HTMLElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${event}`)), META_TIMEOUT_MS)
    el.addEventListener(
      event,
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true }
    )
    el.addEventListener(
      'error',
      () => {
        clearTimeout(timer)
        reject(new Error('media error'))
      },
      { once: true }
    )
  })
}

async function videoMeta(file: File): Promise<MediaMeta> {
  const url = URL.createObjectURL(file)
  const v = document.createElement('video')
  v.muted = true
  v.preload = 'metadata'
  v.src = url
  try {
    await waitEvent(v, 'loadedmetadata')
    const width = v.videoWidth || null
    const height = v.videoHeight || null
    const duration = Number.isFinite(v.duration) ? v.duration : null
    let thumb: Blob | null = null
    if (width && height) {
      v.currentTime = Math.min(1, (duration ?? 2) * 0.1)
      await waitEvent(v, 'seeked')
      thumb = await canvasToBlob(drawScaled(v, width, height))
    }
    return { width, height, duration, thumb }
  } finally {
    v.removeAttribute('src')
    v.load()
    URL.revokeObjectURL(url)
  }
}

async function audioMeta(file: File): Promise<MediaMeta> {
  const url = URL.createObjectURL(file)
  const a = document.createElement('audio')
  a.preload = 'metadata'
  a.src = url
  try {
    await waitEvent(a, 'loadedmetadata')
    return { width: null, height: null, duration: Number.isFinite(a.duration) ? a.duration : null, thumb: null }
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Размеры, длительность и миниатюра. Ошибки не фатальны: файл загрузится и без них. */
export async function prepareMeta(file: File, mime: string): Promise<MediaMeta> {
  const empty: MediaMeta = { width: null, height: null, duration: null, thumb: null }
  try {
    const kind = kindOf(mime)
    if (kind === 'image') return await imageMeta(file, mime)
    if (kind === 'video') return await videoMeta(file)
    if (kind === 'audio') return await audioMeta(file)
  } catch (err) {
    console.warn('[files] не удалось прочитать метаданные', file.name, err)
  }
  return empty
}

export class UploadError extends Error {}

/** Загрузка с прогрессом (XMLHttpRequest — у fetch нет прогресса отправки). */
export function uploadBlob(
  blob: Blob,
  params: { name: string; type: string; width?: number | null; height?: number | null; duration?: number | null; thumbOf?: string; purpose?: 'avatar' },
  onProgress: (fraction: number) => void,
  register?: (xhr: XMLHttpRequest) => void
): Promise<FileInfo> {
  return new Promise((resolve, reject) => {
    const url = uploadUrl({ ...params, duration: params.duration ? params.duration.toFixed(2) : null })
    const token = getApp().fileToken
    if (!url || !token) {
      reject(new UploadError('Нет соединения с сервером'))
      return
    }
    const xhr = new XMLHttpRequest()
    register?.(xhr)
    xhr.open('PUT', url)
    xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.setRequestHeader('Content-Type', params.type || 'application/octet-stream')
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total)
    }
    xhr.onload = () => {
      let body: { file?: FileInfo; error?: string } = {}
      try {
        body = JSON.parse(xhr.responseText) as typeof body
      } catch {
        /* не JSON */
      }
      if (xhr.status === 200 && body.file) resolve(body.file)
      else reject(new UploadError(body.error ?? `Сервер ответил ${xhr.status}`))
    }
    xhr.onerror = () => reject(new UploadError('Связь с хостом прервалась во время загрузки'))
    xhr.onabort = () => reject(new UploadError('Загрузка отменена'))
    xhr.send(blob)
  })
}

/** Удалить свой ещё не отправленный файл (например, убранный из черновика). */
export function deleteUploaded(id: string): void {
  const url = fileUrl(id)
  const token = getApp().fileToken
  if (!url || !token) return
  fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined)
}

/** Квадратная аватарка 256×256 в WebP из любой картинки. */
export async function makeAvatar(file: File): Promise<{ blob: Blob; dataUrl: string }> {
  const bmp = await createImageBitmap(file)
  const side = Math.min(bmp.width, bmp.height)
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 256
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas недоступен')
  ctx.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, 256, 256)
  bmp.close()
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob((b) => r(b), 'image/webp', 0.9))
  if (!blob) throw new Error('Не удалось подготовить аватарку')
  return { blob, dataUrl: canvas.toDataURL('image/webp', 0.9) }
}

export async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl)
  return res.blob()
}
