type SfxKey = 'send' | 'receive' | 'live' | 'reject'

let audioContext: AudioContext | null = null
let unlocked = false

const getAudioContext = (): AudioContext | null => {
  if (typeof window === 'undefined') return null
  const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextCtor) return null
  if (!audioContext) {
    audioContext = new AudioContextCtor()
  }
  return audioContext
}

const unlockAudio = async () => {
  const ctx = getAudioContext()
  if (!ctx) return
  if (ctx.state === 'suspended') {
    await ctx.resume()
  }
  unlocked = ctx.state === 'running'
}

const withSoftEnvelope = (
  ctx: AudioContext,
  oscillator: OscillatorNode,
  gainNode: GainNode,
  volume: number,
  durationSec: number
) => {
  const now = ctx.currentTime
  gainNode.gain.setValueAtTime(0.0001, now)
  gainNode.gain.exponentialRampToValueAtTime(volume, now + 0.018)
  gainNode.gain.exponentialRampToValueAtTime(0.0001, now + durationSec)
  oscillator.start(now)
  oscillator.stop(now + durationSec + 0.01)
}

const playTone = (freq: number, durationSec: number, volume: number, type: OscillatorType, offsetSec = 0) => {
  const ctx = getAudioContext()
  if (!ctx || !unlocked) return

  const oscillator = ctx.createOscillator()
  const gainNode = ctx.createGain()
  const filter = ctx.createBiquadFilter()

  oscillator.type = type
  oscillator.frequency.setValueAtTime(freq, ctx.currentTime + offsetSec)
  filter.type = 'lowpass'
  filter.frequency.setValueAtTime(2200, ctx.currentTime)
  filter.Q.setValueAtTime(0.65, ctx.currentTime)

  oscillator.connect(filter)
  filter.connect(gainNode)
  gainNode.connect(ctx.destination)

  withSoftEnvelope(ctx, oscillator, gainNode, volume, durationSec)
}

const playPattern = (key: SfxKey) => {
  switch (key) {
    case 'send':
      playTone(560, 0.11, 0.035, 'sine')
      playTone(760, 0.15, 0.03, 'triangle', 0.08)
      break
    case 'receive':
      playTone(520, 0.1, 0.03, 'triangle')
      playTone(680, 0.14, 0.036, 'sine', 0.07)
      break
    case 'live':
      playTone(460, 0.09, 0.022, 'sine')
      playTone(610, 0.12, 0.024, 'sine', 0.06)
      break
    case 'reject':
      playTone(350, 0.11, 0.03, 'sawtooth')
      playTone(280, 0.16, 0.028, 'triangle', 0.07)
      break
    default:
      break
  }
}

const playSfx = async (key: SfxKey) => {
  try {
    await unlockAudio()
    playPattern(key)
  } catch {
    // Ignore audio failures so payment flows never break.
  }
}

const setupSfx = () => {
  if (typeof window === 'undefined') return

  const unlockOnce = async () => {
    await unlockAudio()
    if (unlocked) {
      window.removeEventListener('pointerdown', unlockOnce)
      window.removeEventListener('keydown', unlockOnce)
      window.removeEventListener('touchstart', unlockOnce)
    }
  }

  window.addEventListener('pointerdown', unlockOnce, { passive: true })
  window.addEventListener('keydown', unlockOnce)
  window.addEventListener('touchstart', unlockOnce, { passive: true })
}

export { playSfx, setupSfx }
