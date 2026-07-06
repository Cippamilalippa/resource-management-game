/**
 * Generative ambient music + factory ambience, synthesised with the Web Audio API so the game ships
 * no audio asset files (the same approach as {@link sfx}). Two layers, both purely wall-clock and
 * sim-independent — they only ever *read* host-side signals, never sim state, so determinism is
 * untouched:
 *
 *  1. A calm, slowly-evolving pad — a major-pentatonic chord pool voiced by detuned oscillators
 *     through a lowpass with a slow LFO, long attack/release, chord changes every ~20–40 s with
 *     gentle voice-leading (one note moves at a time), plus occasional soft plucked notes echoed
 *     through a feedback delay. "Quiet sci-fi frontier", low overall gain, never intrusive.
 *  2. A soft filtered-noise machine-hum bed whose intensity follows how busy the factory is (the
 *     count of active crafters the boot loop samples ~4 Hz), ramped over seconds so it reads as
 *     texture, not noise.
 *
 * The whole thing runs on the single AudioContext owned by {@link sfx} (created on the first user
 * gesture, per the browser autoplay policy) and is a silent no-op in any non-browser/headless
 * context. The global `M` mute (owned by {@link sfx}) gates both layers; a separate "Music volume"
 * slider and "Ambience" toggle live in the settings store. CPU stays trivial: a fixed handful of
 * persistent nodes and one coarse ~1 s interval that advances the pattern on the AudioContext clock
 * — no per-frame JS timers.
 */
import { sfx } from './sfx.ts'

// ── Pure musical model (no Web Audio — safe to import in Node/tests) ─────────────────────────────

/** Convert a MIDI note number to its frequency in Hz (A4 = 69 = 440 Hz, equal temperament). */
export function midiToFreq(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12)
}

/** Semitone offsets of the major pentatonic scale within an octave (root, 2nd, 3rd, 5th, 6th). */
const PENTATONIC = [0, 2, 4, 7, 9] as const

/** The lowest scale note, in MIDI (C3). Low enough to sit under the mix as a pad. */
const ROOT_MIDI = 48

/** How many octaves of the pentatonic the pad may roam across. */
const SCALE_OCTAVES = 3

/**
 * The pad's note pool: the major pentatonic stacked across {@link SCALE_OCTAVES} octaves from
 * {@link ROOT_MIDI}, as ascending MIDI notes. Chords are expressed as indices into this array, so
 * "move one scale step" is simply ±1 on an index — the voice-leading stays diatonic by construction.
 */
export const SCALE: readonly number[] = buildScale(ROOT_MIDI, PENTATONIC, SCALE_OCTAVES)

function buildScale(root: number, offsets: readonly number[], octaves: number): number[] {
  const out: number[] = []
  for (let o = 0; o < octaves; o++) for (const off of offsets) out.push(root + o * 12 + off)
  return out
}

/** How many simultaneous pad voices (notes) a chord holds. */
export const VOICE_COUNT = 3

/**
 * The opening chord as indices into {@link SCALE}: the low root, its pentatonic third and sixth —
 * a soft, open, unresolved voicing. Voice-leading walks away from here one note at a time.
 */
export function initialChord(): number[] {
  return [0, 2, 4]
}

/**
 * Voice-lead one step: return the next chord by moving exactly one voice up or down by a single
 * scale step, keeping every voice in range and distinct. Pure and deterministic given the injected
 * `rng` (a `() => number` in [0, 1)); the runtime passes `Math.random`, tests pass a seeded RNG.
 * Voice *positions* are preserved (the array is not re-sorted) so each audio voice keeps its
 * identity and can glide smoothly to its new note. If the chosen move is blocked on both sides the
 * chord is returned unchanged (a held bar), so the result is always a valid chord.
 */
export function nextChord(prev: readonly number[], rng: () => number): number[] {
  const next = prev.slice()
  const vi = Math.min(next.length - 1, Math.floor(rng() * next.length))
  const dir = rng() < 0.5 ? -1 : 1
  const cur = next[vi]!
  const tryMove = (step: number): number | null => {
    const cand = cur + step
    if (cand < 0 || cand >= SCALE.length) return null
    for (let i = 0; i < next.length; i++) if (i !== vi && next[i] === cand) return null
    return cand
  }
  const moved = tryMove(dir) ?? tryMove(-dir)
  if (moved === null) return next // held: both neighbours blocked
  next[vi] = moved
  return next
}

/** Peak gain of the factory-ambience hum bed at full tilt (kept low — it's a texture, not noise). */
export const AMBIENCE_MAX_GAIN = 0.09

/**
 * Map the number of active crafters to the ambience hum's target gain. Idle → silent; busier →
 * louder along a saturating curve so a handful of machines already reads clearly while a sprawling
 * factory never gets shrill (it approaches, but never reaches, {@link AMBIENCE_MAX_GAIN}). Pure math,
 * unit-tested; the runtime ramps toward this target over a couple of seconds.
 */
export function ambienceGainFor(activeCrafters: number): number {
  if (!Number.isFinite(activeCrafters) || activeCrafters <= 0) return 0
  return AMBIENCE_MAX_GAIN * (1 - Math.exp(-activeCrafters / 10))
}

// ── Runtime tunables ─────────────────────────────────────────────────────────────────────────────

/** Overall pad gain at music-volume 100% (before the volume multiplier and the mute/scene gates). */
const PAD_BASE_GAIN = 0.14
/** Detune spread (cents) between the two oscillators of each pad voice — a gentle chorus. */
const VOICE_DETUNE_CENTS = 7
/** Seconds a voice takes to glide to its new note on a chord change (slow, so moves are inaudible). */
const CHORD_GLIDE_S = 5
/** Chord-change interval bounds (seconds): a new voicing lands every ~20–40 s. */
const CHORD_MIN_S = 20
const CHORD_MAX_S = 40
/** Per-tick probability that a soft melodic pluck sounds (checked on the ~1 s pattern interval). */
const PLUCK_CHANCE = 0.14
/** Seconds the pad/scene gates take to fade in/out when play starts, stops, or mute toggles. */
const FADE_S = 1.5
/** Seconds the ambience hum takes to ramp to a new intensity target (smooth, reads as texture). */
const AMBIENCE_RAMP_S = 2.5
/** How often the pattern advances (ms). Coarse on purpose — scheduling rides the AudioContext clock. */
const TICK_MS = 1000

type Ctx = AudioContext

/** One pad voice: two detuned oscillators summed through a shared gain, holding one scale index. */
interface PadVoice {
  readonly a: OscillatorNode
  readonly b: OscillatorNode
  index: number
}

/** The live Web Audio graph, built once on the first gesture. Null until then / when unavailable. */
interface Graph {
  readonly ctx: Ctx
  /** Master gate: music volume × (playing ? 1 : 0) × (muted ? 0 : 1), ramped on every change. */
  readonly out: GainNode
  readonly padGain: GainNode
  readonly ambienceGain: GainNode
  readonly voices: PadVoice[]
  /** Feedback-delay send for the plucked melody echoes. */
  readonly delayIn: GainNode
  chord: number[]
  /** AudioContext time (s) at which the next chord change is due. */
  nextChordAt: number
}

let graph: Graph | null = null
let started = false
let playing = false
let musicVolume = 0.6 // 0–1, from the settings "Music volume" slider
let ambienceEnabled = true
let activeCrafters = 0
let tickTimer: ReturnType<typeof setInterval> | undefined

/** A white-noise buffer, filled once with {@link Math.random} (allowed host-side — sim-independent). */
function noiseBuffer(ctx: Ctx): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * 2) // 2 s loop
  const buf = ctx.createBuffer(1, len, ctx.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
  return buf
}

/** Build the persistent node graph (idempotent). Only ever called from {@link resume} on a gesture. */
function build(ctx: Ctx): Graph {
  const now = ctx.currentTime

  // Master gate → destination. Starts silent; the gates below ramp it up once playing.
  const out = ctx.createGain()
  out.gain.setValueAtTime(0.0001, now)
  out.connect(ctx.destination)

  // ── Pad: detuned voices → lowpass (LFO-swept) → padGain → out ──
  const padGain = ctx.createGain()
  padGain.gain.setValueAtTime(PAD_BASE_GAIN, now)
  const filter = ctx.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.setValueAtTime(700, now)
  filter.Q.setValueAtTime(0.8, now)
  filter.connect(padGain).connect(out)
  // Slow LFO breathing the cutoff for gentle movement (no per-frame JS — it lives in the audio graph).
  const lfo = ctx.createOscillator()
  lfo.frequency.setValueAtTime(0.05, now)
  const lfoGain = ctx.createGain()
  lfoGain.gain.setValueAtTime(220, now)
  lfo.connect(lfoGain).connect(filter.frequency)
  lfo.start()

  const chord = initialChord()
  const voices: PadVoice[] = []
  for (let v = 0; v < VOICE_COUNT; v++) {
    const idx = chord[v] ?? 0
    const freq = midiToFreq(SCALE[idx]!)
    const vGain = ctx.createGain()
    vGain.gain.setValueAtTime(1 / VOICE_COUNT, now)
    vGain.connect(filter)
    const a = ctx.createOscillator()
    a.type = 'triangle'
    a.frequency.setValueAtTime(freq, now)
    a.detune.setValueAtTime(-VOICE_DETUNE_CENTS, now)
    const b = ctx.createOscillator()
    b.type = 'sine'
    b.frequency.setValueAtTime(freq, now)
    b.detune.setValueAtTime(VOICE_DETUNE_CENTS, now)
    a.connect(vGain)
    b.connect(vGain)
    a.start()
    b.start()
    voices.push({ a, b, index: idx })
  }

  // ── Melody echo: a feedback delay the plucks feed into, mixed back into the pad bus ──
  const delayIn = ctx.createGain()
  delayIn.gain.setValueAtTime(1, now)
  const delay = ctx.createDelay(1.5)
  delay.delayTime.setValueAtTime(0.42, now)
  const feedback = ctx.createGain()
  feedback.gain.setValueAtTime(0.42, now)
  delayIn.connect(delay)
  delay.connect(feedback).connect(delay) // feedback loop
  delay.connect(padGain) // echoes ride the pad bus (so music volume + gates cover them)

  // ── Ambience: looping noise → bandpass → lowpass → ambienceGain → out ──
  const ambienceGain = ctx.createGain()
  ambienceGain.gain.setValueAtTime(0.0001, now)
  ambienceGain.connect(out)
  const noise = ctx.createBufferSource()
  noise.buffer = noiseBuffer(ctx)
  noise.loop = true
  const band = ctx.createBiquadFilter()
  band.type = 'bandpass'
  band.frequency.setValueAtTime(180, now) // low machine-hum band
  band.Q.setValueAtTime(0.7, now)
  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.setValueAtTime(500, now)
  noise.connect(band).connect(lp).connect(ambienceGain)
  noise.start()

  return {
    ctx,
    out,
    padGain,
    ambienceGain,
    voices,
    delayIn,
    chord,
    nextChordAt: now + CHORD_MIN_S,
  }
}

/** The master gate's target gain: music volume, silenced when muted or not in play. */
function outTarget(): number {
  if (sfx.isMuted() || !playing) return 0.0001
  return Math.max(0.0001, musicVolume)
}

/** Ramp a param toward a target over `seconds`, from its current value (click-free). */
function ramp(param: AudioParam, target: number, seconds: number, now: number): void {
  param.cancelScheduledValues(now)
  param.setValueAtTime(param.value, now)
  param.linearRampToValueAtTime(target, now + seconds)
}

/** Re-apply the master gate (called whenever volume, play state, or mute changes). */
function syncOut(): void {
  if (!graph) return
  ramp(graph.out.gain, outTarget(), FADE_S, graph.ctx.currentTime)
}

/** Re-apply the ambience target from the current activity + enabled flag. */
function syncAmbience(): void {
  if (!graph) return
  const target = ambienceEnabled ? Math.max(0.0001, ambienceGainFor(activeCrafters)) : 0.0001
  ramp(graph.ambienceGain.gain, target, AMBIENCE_RAMP_S, graph.ctx.currentTime)
}

/** Move the pad to a fresh voice-led chord, gliding each changed voice to its new note. */
function advanceChord(g: Graph): void {
  const now = g.ctx.currentTime
  g.chord = nextChord(g.chord, Math.random)
  for (let v = 0; v < g.voices.length; v++) {
    const voice = g.voices[v]!
    const idx = g.chord[v] ?? voice.index
    if (idx === voice.index) continue
    voice.index = idx
    const freq = midiToFreq(SCALE[idx]!)
    ramp(voice.a.frequency, freq, CHORD_GLIDE_S, now)
    ramp(voice.b.frequency, freq, CHORD_GLIDE_S, now)
  }
  const span = CHORD_MIN_S + Math.random() * (CHORD_MAX_S - CHORD_MIN_S)
  g.nextChordAt = now + span
}

/** Sound a soft plucked sine (a scale note near the top of the pool) through the echo send. */
function pluck(g: Graph): void {
  const now = g.ctx.currentTime
  // Pick a note from the upper half of the scale so the melody sits above the pad.
  const lo = Math.floor(SCALE.length / 2)
  const idx = Math.min(SCALE.length - 1, lo + Math.floor(Math.random() * (SCALE.length - lo)))
  const osc = g.ctx.createOscillator()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(midiToFreq(SCALE[idx]!), now)
  const env = g.ctx.createGain()
  const peak = 0.09
  env.gain.setValueAtTime(0.0001, now)
  env.gain.exponentialRampToValueAtTime(peak, now + 0.01)
  env.gain.exponentialRampToValueAtTime(0.0001, now + 1.6)
  osc.connect(env)
  env.connect(g.padGain) // dry
  env.connect(g.delayIn) // echoed
  osc.start(now)
  osc.stop(now + 1.7)
}

/** The coarse pattern clock: advance chords when due and occasionally pluck. No per-frame work. */
function tick(): void {
  const g = graph
  if (!g || !playing || sfx.isMuted()) return
  if (g.ctx.state === 'suspended') void g.ctx.resume()
  if (g.ctx.currentTime >= g.nextChordAt) advanceChord(g)
  if (Math.random() < PLUCK_CHANCE) pluck(g)
}

export const music = {
  /**
   * Unlock and start audio in response to a user gesture (pointer/keydown). Builds the graph on the
   * first call, resumes the context, and starts the pattern clock. No-op when Web Audio is
   * unavailable. Safe to call repeatedly — only the first call does the work.
   */
  resume: (): void => {
    if (started) {
      if (graph && graph.ctx.state === 'suspended') void graph.ctx.resume()
      return
    }
    const ctx = sfx.context()
    if (!ctx) return
    started = true
    graph = build(ctx)
    if (ctx.state === 'suspended') void ctx.resume()
    syncOut()
    syncAmbience()
    if (tickTimer === undefined) tickTimer = setInterval(tick, TICK_MS)
    // Keep both layers gated on the global `M` mute without a second key handler.
    sfx.subscribeMuted(syncOut)
  },

  /** Enter/leave the "playing" scene — fades the music+ambience in during play, out in menus. */
  setPlaying: (value: boolean): void => {
    if (playing === value) return
    playing = value
    syncOut()
  },

  /** Set the music-layer volume (0–1). Persistence + the 0–100 mapping live in the settings store. */
  setMusicVolume: (value: number): void => {
    musicVolume = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.6
    syncOut()
  },

  /** Toggle the factory-ambience hum bed on/off (music keeps playing either way). */
  setAmbienceEnabled: (value: boolean): void => {
    ambienceEnabled = value
    syncAmbience()
  },

  /**
   * Report how busy the factory is (the count of active crafters), driving the ambience intensity.
   * Called from the boot loop's ~4 Hz HUD refresh; the change ramps in over a couple of seconds.
   */
  setActivity: (count: number): void => {
    activeCrafters = count
    syncAmbience()
  },
}
