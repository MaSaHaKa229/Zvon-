/**
 * Короткие системные звуки, синтезированные WebAudio (без файлов-ресурсов).
 */
export type SoundName =
  | 'join'
  | 'leave'
  | 'self-join'
  | 'self-leave'
  | 'mute'
  | 'unmute'
  | 'deafen'
  | 'undeafen'
  | 'ptt-on'
  | 'ptt-off'
  | 'message'
  | 'mention'

const PATTERNS: Record<SoundName, Array<[freq: number, start: number, dur: number]>> = {
  join: [
    [523, 0, 0.09],
    [784, 0.08, 0.14]
  ],
  leave: [
    [784, 0, 0.09],
    [523, 0.08, 0.14]
  ],
  'self-join': [
    [440, 0, 0.08],
    [660, 0.07, 0.08],
    [880, 0.14, 0.14]
  ],
  'self-leave': [
    [880, 0, 0.08],
    [660, 0.07, 0.08],
    [440, 0.14, 0.14]
  ],
  mute: [[392, 0, 0.1]],
  unmute: [[587, 0, 0.1]],
  deafen: [
    [330, 0, 0.08],
    [262, 0.07, 0.12]
  ],
  undeafen: [
    [262, 0, 0.08],
    [330, 0.07, 0.12]
  ],
  message: [
    [880, 0, 0.07],
    [1175, 0.06, 0.1]
  ],
  mention: [
    [988, 0, 0.08],
    [1319, 0.07, 0.08],
    [1568, 0.14, 0.14]
  ],
  'ptt-on': [[700, 0, 0.04]],
  'ptt-off': [[500, 0, 0.04]]
}

type SinkableContext = AudioContext & { setSinkId?: (id: string) => Promise<void> }

let ctx: SinkableContext | null = null
let sinkId = ''

function applySink(c: SinkableContext): void {
  if (c.setSinkId) c.setSinkId(sinkId).catch(() => undefined)
}

/** AudioContext создаётся только при первом звуке, а не при запуске. */
function context(): AudioContext | null {
  try {
    if (!ctx) {
      ctx = new AudioContext() as SinkableContext
      if (sinkId) applySink(ctx)
    }
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  } catch {
    return null
  }
}

/** Звуки идут в то же устройство вывода, что и голос. */
export function setSoundsOutput(deviceId: string): void {
  if (deviceId === sinkId) return
  sinkId = deviceId
  if (ctx) applySink(ctx)
}

export function playSound(name: SoundName, volume = 0.15): void {
  const c = context()
  if (!c) return
  const now = c.currentTime
  for (const [freq, start, dur] of PATTERNS[name]) {
    const osc = c.createOscillator()
    const gain = c.createGain()
    osc.type = 'sine'
    osc.frequency.value = freq
    gain.gain.setValueAtTime(0, now + start)
    gain.gain.linearRampToValueAtTime(volume, now + start + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + start + dur)
    osc.connect(gain).connect(c.destination)
    osc.start(now + start)
    osc.stop(now + start + dur + 0.02)
  }
}
