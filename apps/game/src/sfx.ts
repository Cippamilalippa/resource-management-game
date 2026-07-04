/**
 * Tiny procedural sound effects, synthesised with the Web Audio API so the game ships no audio
 * asset files. Each cue is a short oscillator blip shaped by a gain envelope. Purely a UI-layer
 * feedback channel driven by wall-clock user actions — it never reads or writes sim state, so
 * determinism is untouched.
 *
 * The AudioContext is created lazily on the first cue (after a user gesture, satisfying browser
 * autoplay policy) and is a no-op in any non-browser/headless context. Muting is user-toggleable
 * and persisted in localStorage.
 */

/** The available cues and their voice: waveform, start/end frequency (Hz), and duration (s). */
interface Voice {
  readonly type: OscillatorType
  readonly from: number
  readonly to: number
  readonly dur: number
  readonly gain: number
}

const VOICES: Record<string, Voice> = {
  place: { type: 'triangle', from: 420, to: 620, dur: 0.07, gain: 0.16 },
  remove: { type: 'sawtooth', from: 320, to: 150, dur: 0.09, gain: 0.16 },
  research: { type: 'sine', from: 660, to: 990, dur: 0.28, gain: 0.2 },
  level: { type: 'sine', from: 520, to: 780, dur: 0.34, gain: 0.2 },
  error: { type: 'square', from: 200, to: 140, dur: 0.12, gain: 0.14 },
}

export type SfxCue = keyof typeof VOICES

const MUTE_KEY = 'factory.sfx.muted'

let ctx: AudioContext | null = null
let muted = readMuted()

function readMuted(): boolean {
  try {
    return globalThis.localStorage?.getItem(MUTE_KEY) === '1'
  } catch {
    return false
  }
}

/** Lazily create (and resume) the shared AudioContext; null when Web Audio is unavailable. */
function audio(): AudioContext | null {
  if (ctx) return ctx
  const Ctor =
    typeof globalThis.AudioContext !== 'undefined'
      ? globalThis.AudioContext
      : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  ctx = new Ctor()
  return ctx
}

export const sfx = {
  isMuted: (): boolean => muted,

  setMuted: (value: boolean): void => {
    muted = value
    try {
      globalThis.localStorage?.setItem(MUTE_KEY, value ? '1' : '0')
    } catch {
      // Ignore storage failures — muting still applies for the session.
    }
  },

  /** Play a cue. No-op when muted or when Web Audio is unavailable (e.g. headless). */
  play: (cue: SfxCue): void => {
    if (muted) return
    const ac = audio()
    if (!ac) return
    if (ac.state === 'suspended') void ac.resume()
    const v = VOICES[cue]
    if (!v) return
    const now = ac.currentTime
    const osc = ac.createOscillator()
    const gain = ac.createGain()
    osc.type = v.type
    osc.frequency.setValueAtTime(v.from, now)
    osc.frequency.exponentialRampToValueAtTime(v.to, now + v.dur)
    // Quick attack, exponential decay to near-silence — a clean, un-clicky blip.
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(v.gain, now + 0.008)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + v.dur)
    osc.connect(gain).connect(ac.destination)
    osc.start(now)
    osc.stop(now + v.dur + 0.02)
  },
}
