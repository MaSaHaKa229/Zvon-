/**
 * Подключение RNNoise к дорожке микрофона через Insertable Streams (MediaStreamTrackProcessor/Generator).
 * Обработка идёт в отдельном воркере, чтобы не нагружать интерфейс.
 */
import RnnoiseWorker from './rnnoise.worker?worker&inline'

declare class MediaStreamTrackProcessor {
  constructor(init: { track: MediaStreamTrack })
  readonly readable: ReadableStream<AudioData>
}
declare class MediaStreamTrackGenerator extends MediaStreamTrack {
  constructor(init: { kind: 'audio' | 'video' })
  readonly writable: WritableStream<AudioData>
}

export interface DenoisedTrack {
  track: MediaStreamTrack
  stop(): void
}

const READY_TIMEOUT_MS = 5_000

export function rnnoiseSupported(): boolean {
  const g = globalThis as Record<string, unknown>
  return typeof g.MediaStreamTrackProcessor === 'function' && typeof g.MediaStreamTrackGenerator === 'function'
}

/** Возвращает очищенную дорожку; при ошибке бросает исключение (вызывающий оставляет исходную). */
export async function createDenoisedTrack(source: MediaStreamTrack): Promise<DenoisedTrack> {
  if (!rnnoiseSupported()) throw new Error('Insertable Streams недоступны')
  const processor = new MediaStreamTrackProcessor({ track: source })
  const generator = new MediaStreamTrackGenerator({ kind: 'audio' })
  const worker = new RnnoiseWorker()

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('RNNoise не запустился вовремя')), READY_TIMEOUT_MS)
    worker.onmessage = (e: MessageEvent<{ type: string; message?: string }>) => {
      clearTimeout(timer)
      if (e.data.type === 'ready') resolve()
      else reject(new Error(e.data.message ?? 'Ошибка RNNoise'))
    }
    worker.onerror = (e) => {
      clearTimeout(timer)
      reject(new Error(e.message || 'Ошибка воркера RNNoise'))
    }
    worker.postMessage({ readable: processor.readable, writable: generator.writable }, [
      processor.readable as unknown as Transferable,
      generator.writable as unknown as Transferable
    ])
  }).catch((err) => {
    worker.terminate()
    generator.stop()
    throw err
  })

  return {
    track: generator,
    stop() {
      worker.terminate()
      generator.stop()
      source.stop()
    }
  }
}
