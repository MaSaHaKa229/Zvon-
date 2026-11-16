/**
 * Картинка-в-картинке для видео плитки (стрим или камера): окошко поверх других приложений.
 * Телефоны и компьютер делают это по-разному:
 *  - Chrome, Edge, Android, приложение Zvon — стандартный requestPictureInPicture();
 *  - Safari (iPhone, iPad, Mac) — свой webkitSetPresentationMode('picture-in-picture').
 * Для живого потока (MediaStream) Safari на iPhone картинку-в-картинке поддерживает.
 */

type WebKitVideo = HTMLVideoElement & {
  webkitSupportsPresentationMode?: (mode: 'picture-in-picture' | 'inline' | 'fullscreen') => boolean
  webkitSetPresentationMode?: (mode: 'picture-in-picture' | 'inline' | 'fullscreen') => void
  webkitPresentationMode?: 'picture-in-picture' | 'inline' | 'fullscreen'
  webkitEnterFullscreen?: () => void
  webkitSupportsFullscreen?: boolean
}

type PipDocument = Document & { pictureInPictureEnabled?: boolean; pictureInPictureElement?: Element | null; exitPictureInPicture?: () => Promise<void> }

/** Умеет ли этот браузер картинку-в-картинке вообще (кнопку показываем только тогда). */
export function pipSupported(): boolean {
  if (typeof document === 'undefined' || typeof HTMLVideoElement === 'undefined') return false
  const doc = document as PipDocument
  if (doc.pictureInPictureEnabled && typeof HTMLVideoElement.prototype.requestPictureInPicture === 'function') return true
  return typeof (HTMLVideoElement.prototype as WebKitVideo).webkitSetPresentationMode === 'function'
}

/** Видео сейчас в окошке картинки-в-картинке. */
export function isInPip(video: HTMLVideoElement): boolean {
  const doc = document as PipDocument
  if (doc.pictureInPictureElement === video) return true
  return (video as WebKitVideo).webkitPresentationMode === 'picture-in-picture'
}

/** Включить или выключить картинку-в-картинке. Вызывать из обработчика нажатия: иначе браузер откажет. */
export async function togglePip(video: HTMLVideoElement): Promise<void> {
  const doc = document as PipDocument
  const wk = video as WebKitVideo
  if (isInPip(video)) {
    if (doc.pictureInPictureElement === video && doc.exitPictureInPicture) await doc.exitPictureInPicture()
    else wk.webkitSetPresentationMode?.('inline')
    return
  }
  if (video.paused) await video.play().catch(() => undefined)
  if (doc.pictureInPictureEnabled && typeof video.requestPictureInPicture === 'function') {
    await video.requestPictureInPicture()
    return
  }
  if (wk.webkitSupportsPresentationMode?.('picture-in-picture')) {
    wk.webkitSetPresentationMode?.('picture-in-picture')
    return
  }
  throw new Error('Картинка-в-картинке здесь не поддерживается')
}

/**
 * Следить за входом и выходом из картинки-в-картинке (в том числе когда окошко закрыли системной кнопкой).
 * Возвращает функцию отписки.
 */
export function onPipChange(video: HTMLVideoElement, listener: (inPip: boolean) => void): () => void {
  const handler = (): void => listener(isInPip(video))
  const events = ['enterpictureinpicture', 'leavepictureinpicture', 'webkitpresentationmodechanged']
  for (const e of events) video.addEventListener(e, handler)
  return () => {
    for (const e of events) video.removeEventListener(e, handler)
  }
}

/**
 * iPhone не умеет разворачивать на весь экран произвольный блок страницы — только само видео через системный плеер
 * (в нём, кстати, есть и своя кнопка картинки-в-картинке). Возвращает true, если системный плеер открыт.
 */
export function enterNativeVideoFullscreen(video: HTMLVideoElement): boolean {
  const wk = video as WebKitVideo
  if (typeof wk.webkitEnterFullscreen !== 'function' || wk.webkitSupportsFullscreen === false) return false
  try {
    wk.webkitEnterFullscreen()
    return true
  } catch {
    return false
  }
}
