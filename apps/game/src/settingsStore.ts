/**
 * UI-side store for player-facing options, persisted to localStorage. Like the other tiny external
 * stores, React reads it via useSyncExternalStore; the boot loop (main.tsx) also polls it each frame
 * for the autosave cadence, pause-on-blur behaviour and edge-scroll toggle. It holds *presentation
 * and host-side intent only* — never sim state — so determinism is untouched.
 *
 * Volume is the single source of truth for the sfx gain multiplier: whenever it changes we push it
 * into {@link sfx}, which still layers the binary `M`-key mute on top (mute wins over any volume).
 */
import { sfx } from './sfx.ts'

/** Autosave cadence choices, in minutes. `0` means autosave is disabled. */
export const AUTOSAVE_OPTIONS = [0, 1, 3, 5, 10] as const
export type AutosaveMinutes = (typeof AUTOSAVE_OPTIONS)[number]

/** UI-scale bounds, as a percentage applied to the overlay root. */
export const UI_SCALE_MIN = 80
export const UI_SCALE_MAX = 130

/** Master-volume bounds (a percentage mapped to a 0–1 gain multiplier for {@link sfx}). */
export const VOLUME_MIN = 0
export const VOLUME_MAX = 100

/** The persisted settings — pure data, safe to serialize verbatim. */
export interface Settings {
  /** Master SFX volume, 0–100. Mapped to a 0–1 gain; the `M` mute still overrides it. */
  readonly masterVolume: number
  /** Overlay UI scale as a percentage (see {@link UI_SCALE_MIN}/{@link UI_SCALE_MAX}). */
  readonly uiScale: number
  /** Autosave cadence in minutes; `0` disables autosave. */
  readonly autosaveMin: AutosaveMinutes
  /** Whether moving the cursor to a screen edge pans the camera. */
  readonly edgeScroll: boolean
  /** Whether the sim auto-pauses when the game window loses focus (Q6). */
  readonly pauseOnBlur: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  masterVolume: 80,
  uiScale: 100,
  autosaveMin: 3,
  edgeScroll: true,
  pauseOnBlur: false,
}

/** Clamp a number into `[min, max]`, falling back to `fallback` for non-finite input. */
function clampNum(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** Snap an autosave value to the nearest allowed option, defaulting when absent/invalid. */
function snapAutosave(value: unknown): AutosaveMinutes {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SETTINGS.autosaveMin
  let best: AutosaveMinutes = AUTOSAVE_OPTIONS[0]
  let bestDist = Infinity
  for (const opt of AUTOSAVE_OPTIONS) {
    const dist = Math.abs(opt - value)
    if (dist < bestDist) {
      bestDist = dist
      best = opt
    }
  }
  return best
}

/** Coerce an arbitrary partial into a fully valid {@link Settings} (clamped + defaulted). */
export function clampSettings(partial: Partial<Settings> | null | undefined): Settings {
  const p = partial ?? {}
  return {
    masterVolume: clampNum(p.masterVolume, VOLUME_MIN, VOLUME_MAX, DEFAULT_SETTINGS.masterVolume),
    uiScale: clampNum(p.uiScale, UI_SCALE_MIN, UI_SCALE_MAX, DEFAULT_SETTINGS.uiScale),
    autosaveMin: snapAutosave(p.autosaveMin),
    edgeScroll: typeof p.edgeScroll === 'boolean' ? p.edgeScroll : DEFAULT_SETTINGS.edgeScroll,
    pauseOnBlur: typeof p.pauseOnBlur === 'boolean' ? p.pauseOnBlur : DEFAULT_SETTINGS.pauseOnBlur,
  }
}

/** Parse persisted JSON into valid settings; any malformed input yields the defaults. */
export function parseSettings(raw: string | null): Settings {
  if (!raw) return { ...DEFAULT_SETTINGS }
  try {
    const parsed = JSON.parse(raw) as Partial<Settings>
    return clampSettings(parsed)
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/** Serialize settings to the persisted JSON form. */
export function serializeSettings(settings: Settings): string {
  return JSON.stringify(settings)
}

/** The gain multiplier (0–1) {@link sfx} should apply for a given master-volume percentage. */
export function volumeGain(masterVolume: number): number {
  return clampNum(masterVolume, VOLUME_MIN, VOLUME_MAX, DEFAULT_SETTINGS.masterVolume) / 100
}

/**
 * Decide whether a window-blur should auto-pause the sim (Q6). We only pause when the feature is
 * enabled, a session is actually running, and it is not already paused — so we never override (nor
 * later clobber) a pause the player set by hand. The caller remembers that *it* paused, and only
 * that self-inflicted pause is lifted on focus.
 */
export function shouldPauseOnBlur(opts: {
  enabled: boolean
  playing: boolean
  alreadyPaused: boolean
}): boolean {
  return opts.enabled && opts.playing && !opts.alreadyPaused
}

const STORAGE_KEY = 'factory.settings'

/** Read the persisted settings, tolerating an unavailable/broken localStorage. */
function readStored(): Settings {
  try {
    return parseSettings(globalThis.localStorage?.getItem(STORAGE_KEY) ?? null)
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

interface SettingsStoreState extends Settings {
  /** Whether the settings modal is open (ephemeral — never persisted). */
  readonly open: boolean
}

let state: SettingsStoreState = { ...readStored(), open: false }
const listeners = new Set<() => void>()

/** Persist the current settings (best-effort — a storage failure still applies for the session). */
function persist(): void {
  try {
    const { open: _open, ...settings } = state
    globalThis.localStorage?.setItem(STORAGE_KEY, serializeSettings(settings))
  } catch {
    // Ignore storage failures — the setting still applies for this session.
  }
}

function emit(): void {
  for (const l of listeners) l()
}

// Push the initial persisted volume into the sfx layer so it matches on first sound.
sfx.setVolume(volumeGain(state.masterVolume))

export const settingsStore = {
  get: (): SettingsStoreState => state,
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  /** Apply a partial update, clamping the merged result, then persist + notify. */
  update: (patch: Partial<Settings>): void => {
    const next = clampSettings({ ...state, ...patch })
    state = { ...next, open: state.open }
    if (patch.masterVolume !== undefined) sfx.setVolume(volumeGain(next.masterVolume))
    persist()
    emit()
  },
  open: (): void => {
    state = { ...state, open: true }
    emit()
  },
  close: (): void => {
    state = { ...state, open: false }
    emit()
  },
  toggle: (): void => {
    state = { ...state, open: !state.open }
    emit()
  },
}
