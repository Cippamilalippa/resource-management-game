/**
 * UI-side store for the M4 core-loop HUD panels (research, village, alerts, production stats).
 * The boot loop (main.tsx) assembles a fresh {@link HudState} from the live sim on the overlay's
 * throttled refresh and pushes it here; the React panels read it via useSyncExternalStore. The
 * sim-side {@link import('./gameLogic.ts')} selectors produce the raw view-models; the host layer
 * enriches them with technology names (the sim only knows opaque integer ids) and formats sim
 * units into "/s" rates. Panels drive research selection through the {@link HudController} the boot
 * loop wires in (only it can enqueue a command on the live world).
 */
import type { VillageStatus, Alert } from './gameLogic.ts'

/** One technology as the research screen shows it, enriched with its human name and status. */
export interface HudTech {
  readonly id: string
  readonly name: string
  /** Already researched (root tech or completed). */
  readonly researched: boolean
  /** Currently being researched. */
  readonly active: boolean
  /** Prerequisites met and not yet researched — selectable now. */
  readonly available: boolean
  /** Per-pack cost: resource colour + amount. */
  readonly cost: readonly { readonly color: number; readonly amount: number }[]
  readonly prereqs: readonly string[]
}

/** Live research state for the research screen. */
export interface HudResearch {
  /** Active tech id, or null when idle. */
  readonly activeId: string | null
  readonly activeName: string | null
  readonly labCount: number
  /** Per-pack progress toward the active tech: colour, required amount, packs accumulated. */
  readonly progress: readonly {
    readonly color: number
    readonly amount: number
    readonly progress: number
  }[]
  /** Every technology, enriched for the tree view. */
  readonly techs: readonly HudTech[]
}

/** Installed throughput for one resource, formatted as per-second rates. */
export interface HudProductionRow {
  readonly color: number
  readonly producedPerSec: number
  readonly consumedPerSec: number
}

/** One onboarding objective, enriched with its display label (the sim only knows an opaque id). */
export interface HudObjective {
  readonly id: string
  readonly label: string
  readonly done: boolean
}

/** The full HUD snapshot the panels render. */
export interface HudState {
  readonly research: HudResearch
  readonly villages: readonly VillageStatus[]
  readonly alerts: readonly Alert[]
  readonly production: readonly HudProductionRow[]
  /** Guided first-objectives checklist; empty once every step is done (panel hides). */
  readonly objectives: readonly HudObjective[]
  /** Current credit balance (the treasury), for the always-visible strip. */
  readonly credits: number
  /** Credits gained/lost per minute across the last HUD refresh window (0 until two samples). */
  readonly creditsPerMin: number
}

/** The imperative surface the panels drive (implemented by the boot loop, which owns the world). */
export interface HudController {
  /** Select a technology as the active research (enqueues set_active_research). */
  selectResearch(id: string): void
}

const initial: HudState = {
  research: { activeId: null, activeName: null, labCount: 0, progress: [], techs: [] },
  villages: [],
  alerts: [],
  production: [],
  objectives: [],
  credits: 0,
  creditsPerMin: 0,
}

let state: HudState = initial
let controller: HudController | null = null
const listeners = new Set<() => void>()

export const hudStore = {
  get: (): HudState => state,
  set: (next: HudState): void => {
    state = next
    for (const l of listeners) l()
  },
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  setController: (c: HudController): void => {
    controller = c
  },
  getController: (): HudController | null => controller,
}
