import { describe, it, expect } from 'vitest'
import {
  MAX_SLOTS,
  ROLE_DEPOSIT,
  ROLE_DRAIN,
  RESEARCH_NONE,
  createGameState,
  registerBuilding,
  registerVillage,
  registerResearchLab,
  villageStatuses,
  researchProgress,
  collectAlerts,
  productionFlows,
  VILLAGE_GROWTH_AFTER,
  VILLAGE_DECLINE_AFTER,
  type GameState,
} from '../gameLogic.ts'

/**
 * The HUD selectors are pure, read-only view-models over a {@link GameState} (they power the M4
 * panels). These build a minimal state by hand — registering crafters / villages / labs directly
 * — so each selector is exercised in isolation from the belt network and the scene.
 */

const GRAIN = 0x101010
const BREAD = 0x202020
const PACK = 0x303030

/** Register a crafter at (x, y): consumes `inAmt` grain → produces `outAmt` bread every `every` ticks. */
function crafter(
  state: GameState,
  eid: number,
  x: number,
  y: number,
  every: number,
  inAmt: number,
  outAmt: number,
): number {
  return registerBuilding(state.buildings, eid, x, y, 1, 1, 1, every, [
    { color: GRAIN, cap: 100, role: ROLE_DEPOSIT, amt: inAmt },
    { color: BREAD, cap: 100, role: ROLE_DRAIN, amt: outAmt },
  ])
}

/** Set slot `k` of building `b` to a given count. */
function setCount(state: GameState, b: number, k: number, n: number): void {
  state.buildings.slotCount[b * MAX_SLOTS + k] = n
}

describe('villageStatuses', () => {
  it('reports stage, level, population, and demands vs. the village buffer', () => {
    const state = createGameState()
    // A store building at the village anchor holds the demanded resources (its buffer).
    const b = registerBuilding(state.buildings, 1, 0, 0, 1, 1, 0, 1, [
      { color: GRAIN, cap: 1000, role: ROLE_DEPOSIT | ROLE_DRAIN, amt: 0 },
      { color: BREAD, cap: 1000, role: ROLE_DEPOSIT | ROLE_DRAIN, amt: 0 },
    ])
    setCount(state, b, 0, 50) // grain
    setCount(state, b, 1, 5) // bread
    state.villages.stages = [
      { population: 10, demands: [{ color: GRAIN, need: 20 }] },
      {
        population: 25,
        demands: [
          { color: GRAIN, need: 20 },
          { color: BREAD, need: 10 },
        ],
      },
    ]
    registerVillage(state.villages, 0, 0)

    const [v] = villageStatuses(state)
    expect(v).toBeDefined()
    expect(v!.stage).toBe(0)
    expect(v!.level).toBe(1)
    expect(v!.maxStage).toBe(1)
    expect(v!.population).toBe(10)
    expect(v!.demands).toEqual([{ color: GRAIN, need: 20, have: 50, met: true }])
    expect(v!.growthNeeded).toBe(VILLAGE_GROWTH_AFTER)
    expect(v!.declineNeeded).toBe(VILLAGE_DECLINE_AFTER)
  })

  it('flags an unmet higher-tier demand at a later stage', () => {
    const state = createGameState()
    const b = registerBuilding(state.buildings, 1, 0, 0, 1, 1, 0, 1, [
      { color: GRAIN, cap: 1000, role: ROLE_DEPOSIT | ROLE_DRAIN, amt: 0 },
      { color: BREAD, cap: 1000, role: ROLE_DEPOSIT | ROLE_DRAIN, amt: 0 },
    ])
    setCount(state, b, 0, 50) // grain met
    setCount(state, b, 1, 3) // bread short of its need of 10
    state.villages.stages = [
      { population: 10, demands: [{ color: GRAIN, need: 20 }] },
      {
        population: 25,
        demands: [
          { color: GRAIN, need: 20 },
          { color: BREAD, need: 10 },
        ],
      },
    ]
    registerVillage(state.villages, 0, 0)
    state.villages.stage[0] = 1 // advance to stage 1

    const [v] = villageStatuses(state)
    expect(v!.level).toBe(2)
    expect(v!.demands).toEqual([
      { color: GRAIN, need: 20, have: 50, met: true },
      { color: BREAD, need: 10, have: 3, met: false },
    ])
  })
})

describe('researchProgress', () => {
  it('is idle on a fresh store', () => {
    const state = createGameState()
    const r = researchProgress(state)
    expect(r.idle).toBe(true)
    expect(r.activeTech).toBe(RESEARCH_NONE)
    expect(r.cost).toEqual([])
    expect(r.labCount).toBe(0)
  })

  it('reports the active tech, lab count, and per-pack progress', () => {
    const state = createGameState()
    registerResearchLab(state.research, 3, 4)
    registerResearchLab(state.research, -2, 7)
    state.research.activeTech = 42
    state.research.costN = 1
    state.research.costColor[0] = PACK
    state.research.costAmount[0] = 20
    state.research.progress[0] = 5

    const r = researchProgress(state)
    expect(r.idle).toBe(false)
    expect(r.activeTech).toBe(42)
    expect(r.labCount).toBe(2)
    expect(r.cost).toEqual([{ color: PACK, amount: 20, progress: 5 }])
  })
})

describe('collectAlerts', () => {
  it('raises a missing-input alert for a crafter starved of an ingredient', () => {
    const state = createGameState()
    const b = crafter(state, 1, 5, 5, 30, 2, 1)
    setCount(state, b, 0, 0) // no grain
    state.buildings.craftTimer[b] = 30 // pinned at cadence => stalled

    const alerts = collectAlerts(state)
    expect(alerts).toEqual([{ kind: 'crafter_missing_input', x: 5, y: 5, color: GRAIN }])
  })

  it('raises an output-full alert when inputs are present but the output has no room', () => {
    const state = createGameState()
    const b = crafter(state, 1, 5, 5, 30, 2, 1)
    setCount(state, b, 0, 10) // grain available
    setCount(state, b, 1, 100) // output at capacity (100 + 1 > 100)
    state.buildings.craftTimer[b] = 30

    const alerts = collectAlerts(state)
    expect(alerts).toEqual([{ kind: 'crafter_output_full', x: 5, y: 5, color: BREAD }])
  })

  it('does not alert on a healthy crafter mid-cycle', () => {
    const state = createGameState()
    const b = crafter(state, 1, 5, 5, 30, 2, 1)
    setCount(state, b, 0, 10)
    state.buildings.craftTimer[b] = 5 // mid-cycle, not pinned at cadence

    expect(collectAlerts(state)).toEqual([])
  })

  it('raises a declining-village alert once its decline timer accrues', () => {
    const state = createGameState()
    state.villages.stages = [{ population: 10, demands: [{ color: GRAIN, need: 20 }] }]
    registerVillage(state.villages, 0, 0)
    state.villages.declineTimer[0] = 60

    expect(collectAlerts(state)).toEqual([{ kind: 'village_declining', x: 0, y: 0 }])
  })
})

describe('productionFlows', () => {
  it('aggregates installed produced/consumed capacity per colour, in units per tick', () => {
    const state = createGameState()
    // Two identical crafters: each consumes 2 grain and produces 1 bread every 30 ticks.
    crafter(state, 1, 5, 5, 30, 2, 1)
    crafter(state, 2, 7, 7, 30, 2, 1)

    const flows = productionFlows(state)
    const bread = flows.find((f) => f.color === BREAD)
    const grain = flows.find((f) => f.color === GRAIN)
    expect(bread).toEqual({ color: BREAD, produced: 2 / 30, consumed: 0 })
    expect(grain).toEqual({ color: GRAIN, produced: 0, consumed: 4 / 30 })
  })

  it('ignores non-crafter store buildings', () => {
    const state = createGameState()
    registerBuilding(state.buildings, 1, 0, 0, 1, 1, 0, 1, [
      { color: GRAIN, cap: 1000, role: ROLE_DEPOSIT | ROLE_DRAIN, amt: 0 },
    ])
    expect(productionFlows(state)).toEqual([])
  })
})
