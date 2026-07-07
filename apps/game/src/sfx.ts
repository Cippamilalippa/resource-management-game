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
// Master gain multiplier (0–1) applied on top of each voice's own gain. Driven by the settings
// store's master-volume slider; the binary `M` mute above still overrides it (mute → silent).
let volume = 1
// Subscribers notified when the `M` mute toggles, so the sibling music/ambience layer can gate
// itself off the same global mute without owning its own key handler or duplicating the flag.
const muteListeners = new Set<() => void>()

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
    for (const l of muteListeners) l()
  },

  /** Subscribe to `M`-mute changes (music/ambience gate themselves off this). Returns unsubscribe. */
  subscribeMuted: (listener: () => void): (() => void) => {
    muteListeners.add(listener)
    return () => muteListeners.delete(listener)
  },

  /**
   * The shared AudioContext, lazily created (and reused by the music/ambience layer so the whole
   * app runs on one context). Null when Web Audio is unavailable (headless/tests). Callers must
   * only create it in response to a user gesture, per the browser autoplay policy.
   */
  context: (): AudioContext | null => audio(),

  /** The current master gain multiplier (0–1). */
  getVolume: (): number => volume,

  /** Set the master gain multiplier (0–1), clamped. Persistence lives in the settings store. */
  setVolume: (value: number): void => {
    volume = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1
  },

  /**
   * Play a cue. No-op when muted, at zero volume, or when Web Audio is unavailable (e.g. headless).
   */
  play: (cue: SfxCue): void => {
    if (muted || volume <= 0) return
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
    // Quick attack, exponential decay to near-silence — a clean, un-clicky blip. The voice's own
    // gain is scaled by the master volume multiplier (kept above the exponential-ramp floor).
    const peak = Math.max(0.0002, v.gain * volume)
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(peak, now + 0.008)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + v.dur)
    osc.connect(gain).connect(ac.destination)
    osc.start(now)
    osc.stop(now + v.dur + 0.02)
  },

  /**
   * A triumphant win fanfare (G5): a rising C-major arpeggio ending on the octave, each note a
   * short triangle blip so it reads as celebratory rather than a single alert. Same lazy-context,
   * mute and headless-safe gating as {@link play}; purely a UI cue, no sim contact.
   */
  playVictory: (): void => {
    if (muted) return
    const ac = audio()
    if (!ac) return
    if (ac.state === 'suspended') void ac.resume()
    const base = ac.currentTime
    // C5, E5, G5, C6 — a bright major arpeggio, notes spaced a beat apart.
    const notes = [523.25, 659.25, 783.99, 1046.5]
    for (let i = 0; i < notes.length; i++) {
      const t = base + i * 0.13
      const osc = ac.createOscillator()
      const gain = ac.createGain()
      osc.type = 'triangle'
      osc.frequency.setValueAtTime(notes[i]!, t)
      // The final octave rings a touch longer for a resolved, celebratory tail.
      const dur = i === notes.length - 1 ? 0.6 : 0.3
      gain.gain.setValueAtTime(0.0001, t)
      gain.gain.exponentialRampToValueAtTime(0.2, t + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur)
      osc.connect(gain).connect(ac.destination)
      osc.start(t)
      osc.stop(t + dur + 0.03)
    }
  },
}
