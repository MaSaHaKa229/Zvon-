/**
 * Раздача веб-версии приложения (out/web) с того же адреса, что и сервер:
 * браузер открывает https://сервер/, интерфейс подключается к /ws этого же сервера.
 */
import { createReadStream, existsSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, normalize, sep } from 'node:path'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg'
}

/** Каталог веб-версии рядом со сборкой сервера (out/main → out/web) или null, если её нет. */
export function findWebDir(explicit?: string): string | null {
  const dir = explicit || join(__dirname, '..', 'web')
  return existsSync(join(dir, 'index.html')) ? dir : null
}

/** true — запрос обработан (отдан файл веб-версии). */
export function serveWeb(req: IncomingMessage, res: ServerResponse, url: URL, webDir: string): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  let rel: string
  try {
    rel = decodeURIComponent(url.pathname)
  } catch {
    return false
  }
  const root = normalize(webDir + sep)
  let file = normalize(join(webDir, rel))
  if (!file.startsWith(root) && file !== normalize(webDir)) return false
  let isFile = existsSync(file) && statSync(file).isFile()
  // Адреса без расширения (/, /channel/…) — это страница приложения.
  if (!isFile && !extname(rel)) {
    file = join(webDir, 'index.html')
    isFile = existsSync(file)
  }
  if (!isFile) return false

  const ext = extname(file).toLowerCase()
  const size = statSync(file).size
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Content-Length': size,
    // Файлы в assets/ с хешем в имени не меняются; index.html — всегда свежий.
    'Cache-Control': rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  })
  if (req.method === 'HEAD') res.end()
  else createReadStream(file).pipe(res)
  return true
}
