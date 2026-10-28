/**
 * Воркер шумоподавления RNNoise: получает кадры микрофона (MediaStreamTrackProcessor),
 * пропускает их через нейросеть по 480 сэмплов (10 мс при 48 кГц) и отдаёт в MediaStreamTrackGenerator.
 * Используется синхронная сборка @jitsi/rnnoise-wasm — WASM встроен в JS, отдельные файлы не нужны.
 */
import createRNNWasmModuleSync from '@jitsi/rnnoise-wasm/dist/rnnoise-sync.js'

interface RnnoiseModule {
  _malloc(bytes: number): number
  _free(ptr: number): void
  _rnnoise_create(): number
  _rnnoise_destroy(state: number): void
  _rnnoise_process_frame(state: number, out: number, input: number): number
  HEAPF32: Float32Array
}

interface InitMessage {
  readable: ReadableStream<AudioData>
  writable: WritableStream<AudioData>
}

const FRAME = 480
const SCALE = 32768

/** Простая очередь сэмплов (размеры маленькие, копирование дешёвое). */
class SampleQueue {
  private buf = new Float32Array(FRAME * 8)
  private len = 0

  get length(): number {
    return this.len
  }

  push(data: Float32Array): void {
    if (this.len + data.length > this.buf.length) {
      const next = new Float32Array(Math.max(this.buf.length * 2, this.len + data.length))
      next.set(this.buf.subarray(0, this.len))
      this.buf = next
    }
    this.buf.set(data, this.len)
    this.len += data.length
  }

  take(n: number): Float32Array {
    const out = this.buf.slice(0, n)
    this.buf.copyWithin(0, n, this.len)
    this.len -= n
    return out
  }
}

interface WorkerScope {
  onmessage: ((e: MessageEvent<InitMessage>) => void) | null
  postMessage(message: unknown): void
}

const ctx = self as unknown as WorkerScope

ctx.onmessage = async (e: MessageEvent<InitMessage>) => {
  const { readable, writable } = e.data
  let mod: RnnoiseModule
  let state = 0
  let ptr = 0
  try {
    mod = createRNNWasmModuleSync() as unknown as RnnoiseModule
    state = mod._rnnoise_create()
    ptr = mod._malloc(FRAME * 4)
  } catch (err) {
    ctx.postMessage({ type: 'error', message: (err as Error).message })
    return
  }

  const input = new SampleQueue()
  const output = new SampleQueue()
  const index = ptr >> 2

  const transform = new TransformStream<AudioData, AudioData>({
    transform(data, controller) {
      // RNNoise обучен на 48 кГц; другие частоты пропускаем без обработки.
      if (data.sampleRate !== 48000) {
        controller.enqueue(data)
        return
      }
      const n = data.numberOfFrames
      const samples = new Float32Array(n)
      data.copyTo(samples, { planeIndex: 0, format: 'f32-planar' })
      const timestamp = data.timestamp
      data.close()

      input.push(samples)
      while (input.length >= FRAME) {
        const frame = input.take(FRAME)
        for (let i = 0; i < FRAME; i++) frame[i] *= SCALE
        mod.HEAPF32.set(frame, index)
        mod._rnnoise_process_frame(state, ptr, ptr)
        const processed = mod.HEAPF32.slice(index, index + FRAME)
        for (let i = 0; i < FRAME; i++) processed[i] /= SCALE
        output.push(processed)
      }
      // На старте выход отстаёт на один кадр — отдаём тишину.
      const out = output.length >= n ? output.take(n) : new Float32Array(n)
      controller.enqueue(new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: n, numberOfChannels: 1, timestamp, data: out as unknown as BufferSource }))
    }
  })

  ctx.postMessage({ type: 'ready' })
  try {
    await readable.pipeThrough(transform).pipeTo(writable)
  } catch {
    /* трек остановлен */
  } finally {
    try {
      mod._free(ptr)
      mod._rnnoise_destroy(state)
    } catch {
      /* ignore */
    }
  }
}
