/**
 * Отдельные окна просмотра видео. Окно открывается как about:blank из того же процесса,
 * поэтому в него можно напрямую передать MediaStream без повторного приёма с сервера.
 */
import type { RemoteVideoView } from '../voice/engine'

interface Popout {
  win: Window
  consumerId: string
  video: HTMLVideoElement
  trackId: string
}

/** Префикс заголовка: по нему main не показывает эти окна в списке для демонстрации. */
const TITLE_PREFIX = 'Zvon — просмотр'

const popouts = new Map<string, Popout>()

type WantFn = (consumerId: string, viewer: string, layer: number | null) => void

let want: WantFn = () => undefined

export function setPopoutWant(fn: WantFn): void {
  want = fn
}

export function popoutViewer(key: string): string {
  return `popout:${key}`
}

export function tileKey(v: Pick<RemoteVideoView, 'source' | 'userId'>): string {
  return `${v.source === 'screen' ? 'screen' : 'cam'}:${v.userId}`
}

export function isPoppedOut(key: string): boolean {
  const p = popouts.get(key)
  return Boolean(p && !p.win.closed)
}

function attach(p: Popout, video: RemoteVideoView): void {
  if (p.consumerId && p.consumerId !== video.consumerId) want(p.consumerId, popoutViewer(keyOf(p)), null)
  p.consumerId = video.consumerId
  if (p.trackId !== video.track.id) {
    p.trackId = video.track.id
    p.video.srcObject = new MediaStream([video.track])
    p.video.play().catch(() => undefined)
  }
  // Отдельное окно обычно большое — просим максимальное качество.
  want(video.consumerId, popoutViewer(keyOf(p)), video.spatialLayers - 1)
}

function keyOf(p: Popout): string {
  for (const [k, v] of popouts) if (v === p) return k
  return ''
}

export function openPopout(video: RemoteVideoView, title: string): void {
  const key = tileKey(video)
  const existing = popouts.get(key)
  if (existing && !existing.win.closed) {
    existing.win.focus()
    return
  }
  const win = window.open('about:blank', `zvon-popout-${key.replace(/[^a-z0-9-]/gi, '_')}`, 'width=1280,height=760')
  if (!win) throw new Error('Не удалось открыть окно просмотра')
  const doc = win.document
  doc.title = `${TITLE_PREFIX}: ${title}`
  const style = doc.createElement('style')
  style.textContent =
    'html,body{margin:0;height:100%;background:#000;overflow:hidden}video{width:100%;height:100%;object-fit:contain;cursor:pointer}'
  doc.head.appendChild(style)
  const v = doc.createElement('video')
  v.autoplay = true
  v.muted = true
  v.playsInline = true
  v.title = 'Двойной клик — на весь экран'
  v.addEventListener('dblclick', () => {
    if (doc.fullscreenElement) void doc.exitFullscreen()
    else void v.requestFullscreen().catch(() => undefined)
  })
  doc.body.appendChild(v)

  const p: Popout = { win, consumerId: '', video: v, trackId: '' }
  popouts.set(key, p)
  attach(p, video)
  win.addEventListener('pagehide', () => {
    if (popouts.get(key) === p) popouts.delete(key)
    want(p.consumerId, popoutViewer(key), null)
  })
}

export function closePopout(key: string): void {
  const p = popouts.get(key)
  popouts.delete(key)
  if (!p) return
  want(p.consumerId, popoutViewer(key), null)
  if (!p.win.closed) p.win.close()
}

/** Видео обновились: окна закрываются, если поток пропал, и переподключаются к новому после перезахода. */
export function syncPopouts(videos: RemoteVideoView[]): void {
  for (const [key, p] of [...popouts]) {
    if (p.win.closed) {
      popouts.delete(key)
      continue
    }
    const v = videos.find((x) => tileKey(x) === key)
    if (!v) closePopout(key)
    else if (v.consumerId !== p.consumerId || v.track.id !== p.trackId) attach(p, v)
  }
}

export function closeAllPopouts(): void {
  for (const key of [...popouts.keys()]) closePopout(key)
}
