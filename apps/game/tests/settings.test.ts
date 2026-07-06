import { describe, it, expect } from 'vitest'
import {
  clampSettings,
  parseSettings,
  serializeSettings,
  volumeGain,
  shouldPauseOnBlur,
  DEFAULT_SETTINGS,
  UI_SCALE_MIN,
  UI_SCALE_MAX,
  VOLUME_MIN,
  VOLUME_MAX,
} from '../src/settingsStore.ts'

describe('clampSettings', () => {
  it('passes valid in-range settings through unchanged', () => {
    const input = {
      masterVolume: 55,
      uiScale: 110,
      autosaveMin: 5 as const,
      edgeScroll: false,
      pauseOnBlur: true,
    }
    expect(clampSettings(input)).toEqual(input)
  })

  it('fills every field with a default when given an empty/nullish partial', () => {
    expect(clampSettings({})).toEqual(DEFAULT_SETTINGS)
    expect(clampSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(clampSettings(undefined)).toEqual(DEFAULT_SETTINGS)
  })

  it('clamps numeric fields to their bounds', () => {
    const hi = clampSettings({ masterVolume: 999, uiScale: 999 })
    expect(hi.masterVolume).toBe(VOLUME_MAX)
    expect(hi.uiScale).toBe(UI_SCALE_MAX)
    const lo = clampSettings({ masterVolume: -50, uiScale: 10 })
    expect(lo.masterVolume).toBe(VOLUME_MIN)
    expect(lo.uiScale).toBe(UI_SCALE_MIN)
  })

  it('rounds fractional numbers and defaults non-finite ones', () => {
    expect(clampSettings({ masterVolume: 42.6 }).masterVolume).toBe(43)
    expect(clampSettings({ uiScale: Number.NaN }).uiScale).toBe(DEFAULT_SETTINGS.uiScale)
    expect(clampSettings({ masterVolume: Infinity }).masterVolume).toBe(
      DEFAULT_SETTINGS.masterVolume,
    )
  })

  it('snaps autosave to the nearest allowed option', () => {
    expect(clampSettings({ autosaveMin: 2 as never }).autosaveMin).toBe(1) // 2 → nearest of {0,1,3,5,10}
    expect(clampSettings({ autosaveMin: 4 as never }).autosaveMin).toBe(3) // 4 → 3 (tie broken low)
    expect(clampSettings({ autosaveMin: 100 as never }).autosaveMin).toBe(10)
    expect(clampSettings({ autosaveMin: 0 }).autosaveMin).toBe(0)
  })

  it('rejects non-boolean toggle values by defaulting', () => {
    expect(clampSettings({ edgeScroll: 'yes' as never }).edgeScroll).toBe(
      DEFAULT_SETTINGS.edgeScroll,
    )
    expect(clampSettings({ pauseOnBlur: 1 as never }).pauseOnBlur).toBe(
      DEFAULT_SETTINGS.pauseOnBlur,
    )
  })
})

describe('parse/serialize round-trip', () => {
  it('round-trips a valid settings object', () => {
    const settings = clampSettings({
      masterVolume: 30,
      uiScale: 90,
      autosaveMin: 10 as const,
      edgeScroll: false,
      pauseOnBlur: true,
    })
    expect(parseSettings(serializeSettings(settings))).toEqual(settings)
  })

  it('falls back to defaults for null, empty, or malformed JSON', () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings('')).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings('{not json')).toEqual(DEFAULT_SETTINGS)
  })

  it('clamps out-of-range values read from storage', () => {
    const parsed = parseSettings(JSON.stringify({ masterVolume: 5000, uiScale: 5 }))
    expect(parsed.masterVolume).toBe(VOLUME_MAX)
    expect(parsed.uiScale).toBe(UI_SCALE_MIN)
  })
})

describe('volumeGain', () => {
  it('maps a 0–100 percentage to a 0–1 gain', () => {
    expect(volumeGain(0)).toBe(0)
    expect(volumeGain(50)).toBe(0.5)
    expect(volumeGain(100)).toBe(1)
  })

  it('clamps out-of-range and non-finite input', () => {
    expect(volumeGain(200)).toBe(1)
    expect(volumeGain(-10)).toBe(0)
    expect(volumeGain(Number.NaN)).toBe(DEFAULT_SETTINGS.masterVolume / 100)
  })
})

describe('shouldPauseOnBlur', () => {
  it('pauses only when enabled, playing, and not already paused', () => {
    expect(shouldPauseOnBlur({ enabled: true, playing: true, alreadyPaused: false })).toBe(true)
  })

  it('does nothing when the feature is disabled', () => {
    expect(shouldPauseOnBlur({ enabled: false, playing: true, alreadyPaused: false })).toBe(false)
  })

  it('does nothing when not in a live session', () => {
    expect(shouldPauseOnBlur({ enabled: true, playing: false, alreadyPaused: false })).toBe(false)
  })

  it('never clobbers a manual pause (already paused → no auto-pause to later lift)', () => {
    expect(shouldPauseOnBlur({ enabled: true, playing: true, alreadyPaused: true })).toBe(false)
  })
})
