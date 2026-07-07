import { describe, it, expect } from 'vitest'
import { hashSnapshot } from '@factory/engine/persistence'
import { PrototypeRegistry } from '@factory/engine/data'
import { bootstrapSim, type Sim } from '../bootstrap.ts'
import {
  MAX_SLOTS,
  buildingAt,
  createGameState,
  goalStatus,
  validateContent,
} from '../gameLogic.ts'

/**
 * G5 — the scenario win goal. The default (abundant) scenario authors a goal of "reach the origin
 * settlement's stage 3"; `goalStatus` derives current-vs-required stage and `reached` read-only from
 * `GameState.config.goal`. These tests prove the flip happens at exactly the authored stage (driving
 * the village like village.test.ts and by setting the stage directly), that goal content is validated,
 * and that the goal survives a save/load round-trip.
 */

/** The origin settlement's building id (its footprint covers the origin). */
function villageBuilding(sim: Sim): number {
  return buildingAt(sim.state.buildings, 0, 0)
}

/** Keep the village's level-1 demand (buffer slot 0) topped up so it grows each cadence. */
function setStage1Buffer(sim: Sim, n: number): void {
  sim.state.buildings.slotCount[villageBuilding(sim) * MAX_SLOTS] = n
}

describe('goalStatus', () => {
  it('exposes the authored goal (abundant → reach stage 4), not yet reached at spawn', async () => {
    const sim = await bootstrapSim(1)
    const g = goalStatus(sim.state)
    expect(g.defined).toBe(true)
    expect(g.requiredStage).toBe(4)
    expect(g.currentStage).toBe(0)
    expect(g.reached).toBe(false)
  })

  it('reports no goal (inert) for a scenario-less GameState', () => {
    const g = goalStatus(createGameState())
    expect(g.defined).toBe(false)
    expect(g.reached).toBe(false)
    expect(g.currentStage).toBe(-1)
  })

  it('tracks the live village stage as it grows (driven like village.test.ts)', async () => {
    const sim = await bootstrapSim(1)
    // Feed the level-1 demand so the village promotes stage 0 → 1 after ~600 ticks of satisfaction.
    setStage1Buffer(sim, 100_000)
    sim.scheduler.runTicks(sim.world, 700)
    const g = goalStatus(sim.state)
    expect(g.currentStage).toBe(1)
    expect(g.reached).toBe(false) // still short of the required stage 4
  })

  it('flips reached exactly at the authored stage, and un-flips below it', async () => {
    const sim = await bootstrapSim(1)
    const v = sim.state.villages
    // One below the goal: not reached.
    v.stage[0] = 3
    expect(goalStatus(sim.state).reached).toBe(false)
    // At the goal: reached.
    v.stage[0] = 4
    const g = goalStatus(sim.state)
    expect(g.currentStage).toBe(4)
    expect(g.reached).toBe(true)
    // Past the goal (a deeper ladder would allow this): still reached.
    v.stage[0] = 5
    expect(goalStatus(sim.state).reached).toBe(true)
    // Back below: no longer reached (the selector is a pure read of the live stage).
    v.stage[0] = 1
    expect(goalStatus(sim.state).reached).toBe(false)
  })
})

/**
 * A minimal but VALID content set with one 2-stage village and a scenario, so each goal-validation
 * rule can be provoked by corrupting exactly one field.
 */
function goalRegistry(goal: unknown): PrototypeRegistry {
  const reg = new PrototypeRegistry()
  reg.register({ id: 'item.grain', type: 'item', color: 1 })
  reg.register({ id: 'terrain.rock', type: 'terrain', color: 2 })
  reg.register({
    id: 'building.mine',
    type: 'crafter',
    craftingCategories: ['mining'],
    speed: 1,
    storage: 100,
  })
  reg.register({
    id: 'recipe.grain',
    type: 'recipe',
    category: 'mining',
    ingredients: [],
    requiresTerrain: 'terrain.rock',
    results: [{ item: 'item.grain', amount: 1 }],
    time: 40,
  })
  reg.register({
    id: 'tech.mining',
    type: 'technology',
    prerequisites: [],
    unlocks: ['recipe.grain', 'building.mine'],
  })
  reg.register({
    id: 'building.village',
    type: 'village',
    accepts: ['item.grain'],
    storage: 100,
    stages: [
      { level: 1, population: 10, demands: [{ item: 'item.grain', ratePerMin: 10 }] },
      { level: 2, population: 20, demands: [{ item: 'item.grain', ratePerMin: 12 }] },
    ],
  })
  reg.register({
    id: 'scenario.x',
    type: 'scenario',
    deposits: ['terrain.rock'],
    patchSize: { min: 3, max: 5 },
    spread: { min: 6, max: 16 },
    ...(goal === undefined ? {} : { goal }),
  })
  return reg
}

describe('validateContent — scenario goal', () => {
  it('accepts a well-formed goal (village id + in-range stage)', () => {
    expect(() =>
      validateContent(goalRegistry({ village: 'building.village', stage: 1 })),
    ).not.toThrow()
  })

  it('accepts a scenario with no goal at all', () => {
    expect(() => validateContent(goalRegistry(undefined))).not.toThrow()
  })

  it('rejects a goal referencing a missing village', () => {
    expect(() => validateContent(goalRegistry({ village: 'building.ghost', stage: 0 }))).toThrow(
      /building\.ghost/,
    )
  })

  it('rejects a goal whose target is not a village', () => {
    expect(() => validateContent(goalRegistry({ village: 'building.mine', stage: 0 }))).toThrow(
      /building\.mine/,
    )
  })

  it('rejects a goal stage beyond the village ladder', () => {
    // The village has 2 stages (0,1); stage 2 could never be reached.
    expect(() => validateContent(goalRegistry({ village: 'building.village', stage: 2 }))).toThrow(
      /out of range/,
    )
  })

  it('rejects a negative or non-integer goal stage', () => {
    expect(() => validateContent(goalRegistry({ village: 'building.village', stage: -1 }))).toThrow(
      /goal\.stage/,
    )
    expect(() =>
      validateContent(goalRegistry({ village: 'building.village', stage: 1.5 })),
    ).toThrow(/goal\.stage/)
  })

  it('rejects a malformed goal object', () => {
    expect(() => validateContent(goalRegistry({ stage: 0 }))).toThrow(/goal\.village/)
    expect(() => validateContent(goalRegistry(42))).toThrow(/goal/)
  })
})

describe('goal survives save/load', () => {
  it('round-trips the goal in config (byte-identical, and goalStatus matches)', async () => {
    const src = await bootstrapSim(7)
    src.scheduler.runTicks(src.world, 120)
    const snap = src.serialize()
    // Restore into a scene-less origin (as a real load does) and re-serialize.
    const dst = await bootstrapSim(7, { startScene: false })
    dst.restore(snap)
    expect(hashSnapshot(dst.serialize())).toBe(hashSnapshot(snap))
    // The goal (target tile + required stage) is preserved, so a loaded save still knows its win state.
    const g = goalStatus(dst.state)
    expect(g.defined).toBe(true)
    expect(g).toEqual(goalStatus(src.state))
  })

  it('is deterministic: same seed + ticks → identical whole-sim hash', async () => {
    const run = async (): Promise<Sim> => {
      const sim = await bootstrapSim(9)
      sim.scheduler.runTicks(sim.world, 300)
      return sim
    }
    const a = await run()
    const b = await run()
    expect(hashSnapshot(a.serialize())).toBe(hashSnapshot(b.serialize()))
  })
})
