/**
 * Read-only HUD selectors over the base game's {@link GameState}. These power the M4 core-loop
 * panels (research, village, alerts, production stats). Like the inspector, they run off the hot
 * path — only on the overlay's throttled refresh — so plain allocation (arrays/maps) is fine;
 * they never run inside a system and never mutate state, so they cannot affect determinism.
 *
 * Values are raw sim units: per-tick flows and cadence counts. The host formats them to "/s"
 * rates and percentages with the engine tick rate (see the app-side HUD store), exactly as the
 * inspector formats its own rates — keeping the engine tick rate out of the sandboxed sim.
 */
import {
  MAX_SLOTS,
  ROLE_DEPOSIT,
  RESEARCH_NONE,
  VILLAGE_GROWTH_AFTER,
  VILLAGE_DECLINE_AFTER,
  buildingAt,
  canAffordTreasury,
  type BuildingStore,
  type CostEntry,
  type GameState,
} from './sim.ts'

/** Total units of resource `color` currently held across building `b`'s stockpile slots. */
function bufferOf(store: BuildingStore, b: number, color: number): number {
  const n = store.slotN[b]!
  let sum = 0
  for (let k = 0; k < n; k++) {
    const i = b * MAX_SLOTS + k
    if (store.slotColor[i] === color) sum += store.slotCount[i]!
  }
  return sum
}

/** One demand of a village's current stage, paired with what its buffer currently holds. */
export interface VillageDemandStatus {
  readonly color: number
  /** Authored consumption rate in units per in-game minute. */
  readonly ratePerMin: number
  /** Units of this resource currently stocked in the village buffer. */
  readonly have: number
  /** True while the buffer holds stock to draw from (a demanded good at zero is a starved miss). */
  readonly met: boolean
}

/** A village's live status for the village panel. */
export interface VillageStatus {
  readonly x: number
  readonly y: number
  /** 0-based stage index. */
  readonly stage: number
  /** Human-facing level (stage + 1). */
  readonly level: number
  /** Top stage index (stages.length - 1). */
  readonly maxStage: number
  readonly population: number
  readonly demands: readonly VillageDemandStatus[]
  /** Cadences of sustained satisfaction accrued toward the next stage. */
  readonly growthTimer: number
  /** Cadences of sustained unmet demand accrued toward dropping a stage. */
  readonly declineTimer: number
  /** Cadences of satisfaction needed to grow. */
  readonly growthNeeded: number
  /** Cadences of unmet demand before a drop. */
  readonly declineNeeded: number
}

/** Resolve every village's current stage, demands vs. buffer, and growth/decline progress. */
export function villageStatuses(state: GameState): VillageStatus[] {
  const v = state.villages
  const out: VillageStatus[] = []
  for (let i = 0; i < v.count; i++) {
    const stage = v.stage[i]!
    const cfg = v.stages[stage]
    const b = buildingAt(state.buildings, v.vx[i]!, v.vy[i]!)
    const demands: VillageDemandStatus[] = []
    if (cfg) {
      for (let d = 0; d < cfg.demands.length; d++) {
        const dem = cfg.demands[d]!
        const have = b >= 0 ? bufferOf(state.buildings, b, dem.color) : 0
        demands.push({
          color: dem.color,
          ratePerMin: dem.ratePerMin,
          have,
          met: dem.ratePerMin === 0 || have > 0,
        })
      }
    }
    out.push({
      x: v.vx[i]!,
      y: v.vy[i]!,
      stage,
      level: stage + 1,
      maxStage: Math.max(0, v.stages.length - 1),
      population: cfg?.population ?? 0,
      demands,
      growthTimer: v.growthTimer[i]!,
      declineTimer: v.declineTimer[i]!,
      growthNeeded: VILLAGE_GROWTH_AFTER,
      declineNeeded: VILLAGE_DECLINE_AFTER,
    })
  }
  return out
}

/** One per-pack cost entry of the active technology, with packs accumulated so far. */
export interface ResearchCostStatus {
  readonly color: number
  readonly amount: number
  readonly progress: number
}

/** The live research progression for the research screen. Ids are opaque integers (see `techTypeOf`). */
export interface ResearchProgress {
  /** Active technology integer id, or {@link RESEARCH_NONE} when idle. */
  readonly activeTech: number
  readonly idle: boolean
  readonly labCount: number
  readonly cost: readonly ResearchCostStatus[]
  /** Integer ids of technologies completed at runtime, in completion order. */
  readonly completed: readonly number[]
}

/** Snapshot the research store's active tech, per-pack progress, and completed set. */
export function researchProgress(state: GameState): ResearchProgress {
  const r = state.research
  const cost: ResearchCostStatus[] = []
  for (let c = 0; c < r.costN; c++) {
    cost.push({ color: r.costColor[c]!, amount: r.costAmount[c]!, progress: r.progress[c]! })
  }
  return {
    activeTech: r.activeTech,
    idle: r.activeTech === RESEARCH_NONE,
    labCount: r.labCount,
    cost,
    completed: r.completed.slice(),
  }
}

/** One banked resource in the build-cost treasury: its colour and how many units are held. */
export interface TreasuryBalance {
  readonly color: number
  readonly amount: number
}

/**
 * The current treasury balances, in the bank's dense index order, for the build-cost readout. The
 * host maps each colour back to its item name/icon (the sim stays string-agnostic). Read-only.
 */
export function treasuryBalances(state: GameState): TreasuryBalance[] {
  const t = state.treasury
  const out: TreasuryBalance[] = []
  for (let i = 0; i < t.n; i++) out.push({ color: t.color[i]!, amount: t.amount[i]! })
  return out
}

/** Whether the treasury can currently afford `cost` — for greying out an unaffordable buildable. */
export function canAfford(state: GameState, cost: readonly CostEntry[]): boolean {
  return canAffordTreasury(state.treasury, cost)
}

/** Why a crafter is stalled, or a village is losing population. */
export type AlertKind = 'crafter_missing_input' | 'crafter_output_full' | 'village_declining'

/** A single actionable alert, anchored to the tile that raised it. */
export interface Alert {
  readonly kind: AlertKind
  readonly x: number
  readonly y: number
  /** The missing / blocking resource colour, for the crafter alerts. */
  readonly color?: number
}

/**
 * Scan for stalled crafters and declining villages. A crafter is stalled when its craft timer is
 * pinned at the cadence (`runCrafters` holds it there when it cannot fire) — attributed to a
 * missing input (a deposit recipe slot short of its `amt`) in preference to a full output (a drain
 * recipe slot with no room), matching the order `runCrafters` itself checks. A village is
 * declining whenever its decline timer has started to accrue.
 */
export function collectAlerts(state: GameState): Alert[] {
  const alerts: Alert[] = []
  const store = state.buildings
  for (let b = 0; b < store.count; b++) {
    if (!store.crafts[b]) continue
    if (store.craftTimer[b]! < store.craftEvery[b]!) continue // healthy or mid-cycle
    const base = b * MAX_SLOTS
    const n = store.slotN[b]!
    let missing = -1
    let full = -1
    for (let k = 0; k < n; k++) {
      const i = base + k
      const amt = store.slotAmt[i]!
      if (amt === 0) continue
      if (store.slotRole[i]! & ROLE_DEPOSIT) {
        if (store.slotCount[i]! < amt) {
          missing = store.slotColor[i]!
          break
        }
      } else if (store.slotCount[i]! + amt > store.slotCap[i]! && full < 0) {
        full = store.slotColor[i]!
      }
    }
    if (missing >= 0) {
      alerts.push({
        kind: 'crafter_missing_input',
        x: store.bx[b]!,
        y: store.by[b]!,
        color: missing,
      })
    } else if (full >= 0) {
      alerts.push({ kind: 'crafter_output_full', x: store.bx[b]!, y: store.by[b]!, color: full })
    }
  }
  const v = state.villages
  for (let i = 0; i < v.count; i++) {
    if (v.declineTimer[i]! > 0) {
      alerts.push({ kind: 'village_declining', x: v.vx[i]!, y: v.vy[i]! })
    }
  }
  return alerts
}

/** The ordered onboarding objectives that guide a new player through the core loop. */
export type ObjectiveId = 'place_crafter' | 'place_belt' | 'place_lab' | 'select_research'

/** One onboarding objective and whether the current world already satisfies it. */
export interface ObjectiveStatus {
  readonly id: ObjectiveId
  readonly done: boolean
}

/**
 * Evaluate the guided first-objectives checklist purely from {@link GameState} — no stored progress,
 * so it always reflects the live world (a step un-ticks if the player deletes what satisfied it).
 * The order mirrors the core loop the onboarding teaches: place a crafter → run a belt → build a lab
 * → pick a technology to research. The host maps each id to its label/hint (the sim stays
 * string-agnostic). Read-only and allocation-light; runs off the hot path like the other selectors.
 */
export function gameObjectives(state: GameState): ObjectiveStatus[] {
  let hasCrafter = false
  for (let b = 0; b < state.buildings.count; b++) {
    if (state.buildings.crafts[b]) {
      hasCrafter = true
      break
    }
  }
  const hasBelt = state.grid.count > 0
  const hasLab = state.research.labCount > 0
  // "Chose research" is satisfied by an active tech or any completed one (a fast research could
  // finish before the panel next refreshes, so completion counts too).
  const choseResearch =
    state.research.activeTech !== RESEARCH_NONE || state.research.completed.length > 0
  return [
    { id: 'place_crafter', done: hasCrafter },
    { id: 'place_belt', done: hasBelt },
    { id: 'place_lab', done: hasLab },
    { id: 'select_research', done: choseResearch },
  ]
}

/** Installed production/consumption capacity for one resource colour, in units per tick. */
export interface ProductionFlow {
  readonly color: number
  /** Units produced per tick across every crafter whose recipe outputs this colour. */
  readonly produced: number
  /** Units consumed per tick across every crafter whose recipe inputs this colour. */
  readonly consumed: number
}

/**
 * Aggregate the installed crafter capacity per resource colour: each recipe slot contributes
 * `amt / craftEvery` units per tick to either the produced (drain/output) or consumed
 * (deposit/input) side. This is the throughput the current factory *could* sustain if fully fed —
 * the static counterpart to the per-building rates the inspector already shows.
 */
export function productionFlows(state: GameState): ProductionFlow[] {
  const store = state.buildings
  const produced = new Map<number, number>()
  const consumed = new Map<number, number>()
  for (let b = 0; b < store.count; b++) {
    if (!store.crafts[b]) continue
    const every = store.craftEvery[b]!
    if (every <= 0) continue
    const base = b * MAX_SLOTS
    const n = store.slotN[b]!
    for (let k = 0; k < n; k++) {
      const i = base + k
      const amt = store.slotAmt[i]!
      if (amt === 0) continue
      const rate = amt / every
      const color = store.slotColor[i]!
      const target = store.slotRole[i]! & ROLE_DEPOSIT ? consumed : produced
      target.set(color, (target.get(color) ?? 0) + rate)
    }
  }
  const colors = new Set<number>([...produced.keys(), ...consumed.keys()])
  const out: ProductionFlow[] = []
  for (const color of colors) {
    out.push({ color, produced: produced.get(color) ?? 0, consumed: consumed.get(color) ?? 0 })
  }
  out.sort((a, b) => b.produced - a.produced || a.color - b.color)
  return out
}
