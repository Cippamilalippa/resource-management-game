import { describe, it, expect } from 'vitest'
import {
  midiToFreq,
  nextChord,
  initialChord,
  SCALE,
  VOICE_COUNT,
  ambienceGainFor,
  AMBIENCE_MAX_GAIN,
} from '../src/music.ts'

/** A tiny deterministic RNG (mulberry32) so voice-leading output is reproducible in tests. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('midiToFreq', () => {
  it('anchors A4 (MIDI 69) at 440 Hz and octaves at 2×', () => {
    expect(midiToFreq(69)).toBeCloseTo(440, 6)
    expect(midiToFreq(81)).toBeCloseTo(880, 6)
    expect(midiToFreq(57)).toBeCloseTo(220, 6)
  })
})

describe('SCALE / initialChord', () => {
  it('is a strictly ascending pool of MIDI notes', () => {
    for (let i = 1; i < SCALE.length; i++) expect(SCALE[i]!).toBeGreaterThan(SCALE[i - 1]!)
  })

  it('opens with distinct, in-range voices', () => {
    const chord = initialChord()
    expect(chord).toHaveLength(VOICE_COUNT)
    expect(new Set(chord).size).toBe(VOICE_COUNT)
    for (const idx of chord) {
      expect(idx).toBeGreaterThanOrEqual(0)
      expect(idx).toBeLessThan(SCALE.length)
    }
  })
})

describe('nextChord voice-leading', () => {
  it('is deterministic for a given RNG seed', () => {
    const runA = walk(initialChord(), mulberry32(1234), 64)
    const runB = walk(initialChord(), mulberry32(1234), 64)
    expect(runA).toEqual(runB)
  })

  it('diverges for a different seed', () => {
    const runA = walk(initialChord(), mulberry32(1), 64)
    const runB = walk(initialChord(), mulberry32(2), 64)
    expect(runA).not.toEqual(runB)
  })

  it('moves at most one voice, by a single scale step, each change', () => {
    const rng = mulberry32(99)
    let chord = initialChord()
    for (let step = 0; step < 500; step++) {
      const next = nextChord(chord, rng)
      let changed = 0
      for (let v = 0; v < chord.length; v++) {
        if (next[v] !== chord[v]) {
          changed++
          expect(Math.abs(next[v]! - chord[v]!)).toBe(1) // single scale step
        }
      }
      expect(changed).toBeLessThanOrEqual(1) // one note at a time (or a held bar)
      chord = next
    }
  })

  it('always yields a valid chord: distinct voices, all in range', () => {
    const rng = mulberry32(7)
    let chord = initialChord()
    for (let step = 0; step < 500; step++) {
      chord = nextChord(chord, rng)
      expect(chord).toHaveLength(VOICE_COUNT)
      expect(new Set(chord).size).toBe(VOICE_COUNT) // no two voices collide
      for (const idx of chord) {
        expect(idx).toBeGreaterThanOrEqual(0)
        expect(idx).toBeLessThan(SCALE.length)
      }
    }
  })

  it('does not mutate the input chord', () => {
    const chord = initialChord()
    const copy = chord.slice()
    nextChord(chord, mulberry32(3))
    expect(chord).toEqual(copy)
  })
})

describe('ambienceGainFor', () => {
  it('is silent when the factory is idle or the count is invalid', () => {
    expect(ambienceGainFor(0)).toBe(0)
    expect(ambienceGainFor(-5)).toBe(0)
    expect(ambienceGainFor(Number.NaN)).toBe(0)
  })

  it('rises monotonically with active crafters', () => {
    let prev = ambienceGainFor(0)
    for (let n = 1; n <= 200; n++) {
      const g = ambienceGainFor(n)
      expect(g).toBeGreaterThan(prev)
      prev = g
    }
  })

  it('saturates below the ceiling (never clips the mix)', () => {
    expect(ambienceGainFor(10)).toBeCloseTo(AMBIENCE_MAX_GAIN * (1 - Math.exp(-1)), 6)
    expect(ambienceGainFor(200)).toBeLessThan(AMBIENCE_MAX_GAIN)
    expect(ambienceGainFor(200)).toBeGreaterThan(AMBIENCE_MAX_GAIN * 0.99)
  })
})

/** Collect `steps` successive chords from `start`, so two runs can be compared for determinism. */
function walk(start: number[], rng: () => number, steps: number): number[][] {
  const out: number[][] = []
  let chord = start
  for (let i = 0; i < steps; i++) {
    chord = nextChord(chord, rng)
    out.push(chord)
  }
  return out
}
