import { describe, it, expect } from 'vitest'
import { hashSnapshot } from '@factory/engine/persistence'
import { bootstrapSim, type Sim } from '../bootstrap.ts'
import {
  MAX_SLOTS,
  ROLE_DEPOSIT,
  ROLE_DRAIN,
  buildingAt,
  recipeTypeOf,
  serializeGameState,
  enqueuePlaceCrafter,
  enqueueSetRecipe,
} from '../gameLogic.ts'

/**
 * The Factorio-style "one machine, pick its recipe" flow: a crafter is placed empty (no recipe →
 * idle) and armed later by `set_recipe`, which rebuilds its stockpile slots, sets its cadence, and
 * records the recipe id. These tests drive the crafter buffers directly (like the village/research
 * tests) to isolate the recipe rule from the belt network, and assert determinism + a save round-
 * trip that preserves the recipe id (the persistence guarantee for the new field).
 */

const ORE = 0x111111
const PLATE = 0x222222
const GEAR = 0x333333
const SMELT = recipeTypeOf('recipe.smelt_plate')
const GEARS = recipeTypeOf('recipe.gears')

const hashSim = (sim: Sim): string => hashSnapshot(sim.serialize())

/** Place an empty 1×1 machine at (x, y) and apply the placement. Returns its dense building id. */
function placeMachine(sim: Sim, x: number, y: number): number {
  enqueuePlaceCrafter(sim.world, {
    x,
    y,
    w: 1,
    h: 1,
    color: 0x445566,
    craftEvery: 30,
    storageCap: 100,
  })
  sim.scheduler.runTicks(sim.world, 1)
  return buildingAt(sim.state.buildings, x, y)
}

describe('empty machine', () => {
  it('places with no recipe and produces nothing until armed', async () => {
    const sim = await bootstrapSim(1)
    const b = placeMachine(sim, 20, 20)
    expect(sim.state.buildings.crafts[b]).toBe(1)
    expect(sim.state.buildings.recipe[b]).toBe(0)
    expect(sim.state.buildings.slotN[b]).toBe(0)
    sim.scheduler.runTicks(sim.world, 300)
    expect(sim.state.buildings.slotN[b]).toBe(0) // still empty — no recipe, no slots
  })
})

describe('set_recipe', () => {
  it('arms an empty machine: builds slots, records the id, and starts crafting', async () => {
    const sim = await bootstrapSim(1)
    const b = placeMachine(sim, 20, 20)
    // An extraction recipe: no inputs, one output every 30 ticks.
    enqueueSetRecipe(sim.world, {
      x: 20,
      y: 20,
      recipe: SMELT,
      inputs: [],
      outputs: [{ color: PLATE, amount: 1 }],
      craftEvery: 30,
      storageCap: 100,
    })
    sim.scheduler.runTicks(sim.world, 300) // 10 cadences of 30 ticks

    expect(sim.state.buildings.recipe[b]).toBe(SMELT)
    expect(sim.state.buildings.slotN[b]).toBe(1)
    expect(sim.state.buildings.slotColor[b * MAX_SLOTS]).toBe(PLATE)
    expect(sim.state.buildings.slotRole[b * MAX_SLOTS]).toBe(ROLE_DRAIN)
    expect(sim.state.buildings.slotCount[b * MAX_SLOTS]).toBe(10) // fired once per cadence
  })

  it('changing the recipe rebuilds the slots and drops the old stock', async () => {
    const sim = await bootstrapSim(1)
    const b = placeMachine(sim, 20, 20)
    enqueueSetRecipe(sim.world, {
      x: 20,
      y: 20,
      recipe: SMELT,
      inputs: [],
      outputs: [{ color: PLATE, amount: 1 }],
      craftEvery: 30,
      storageCap: 100,
    })
    sim.scheduler.runTicks(sim.world, 120)
    expect(sim.state.buildings.slotCount[b * MAX_SLOTS]).toBeGreaterThan(0)

    // Switch to a two-slot recipe (consume ORE → produce GEAR).
    enqueueSetRecipe(sim.world, {
      x: 20,
      y: 20,
      recipe: GEARS,
      inputs: [{ color: ORE, amount: 2 }],
      outputs: [{ color: GEAR, amount: 1 }],
      craftEvery: 30,
      storageCap: 100,
    })
    sim.scheduler.runTicks(sim.world, 1)

    expect(sim.state.buildings.recipe[b]).toBe(GEARS)
    expect(sim.state.buildings.slotN[b]).toBe(2)
    expect(sim.state.buildings.slotColor[b * MAX_SLOTS]).toBe(ORE)
    expect(sim.state.buildings.slotRole[b * MAX_SLOTS]).toBe(ROLE_DEPOSIT)
    expect(sim.state.buildings.slotColor[b * MAX_SLOTS + 1]).toBe(GEAR)
    // No ORE fed in, so it can't craft — the (cleared) output stays at 0, not the old PLATE stock.
    expect(sim.state.buildings.slotCount[b * MAX_SLOTS + 1]).toBe(0)
  })

  it('is a no-op on a tile with no crafter', async () => {
    const sim = await bootstrapSim(1)
    const before = sim.state.buildings.count
    enqueueSetRecipe(sim.world, {
      x: 99,
      y: 99,
      recipe: SMELT,
      inputs: [],
      outputs: [{ color: PLATE, amount: 1 }],
      craftEvery: 30,
      storageCap: 100,
    })
    sim.scheduler.runTicks(sim.world, 1)
    expect(sim.state.buildings.count).toBe(before)
  })

  it('is deterministic: same seed + same recipe commands → identical hash', async () => {
    const run = async (): Promise<Sim> => {
      const sim = await bootstrapSim(4)
      placeMachine(sim, 20, 20)
      enqueueSetRecipe(sim.world, {
        x: 20,
        y: 20,
        recipe: SMELT,
        inputs: [],
        outputs: [{ color: PLATE, amount: 1 }],
        craftEvery: 30,
        storageCap: 100,
      })
      sim.scheduler.runTicks(sim.world, 250)
      return sim
    }
    const a = await run()
    const b = await run()
    expect(hashSim(a)).toBe(hashSim(b))
  })
})

describe('recipe save/load round-trip', () => {
  it('preserves the recipe id and hash across serialize→restore', async () => {
    const src = await bootstrapSim(6)
    placeMachine(src, 20, 20)
    enqueueSetRecipe(src.world, {
      x: 20,
      y: 20,
      recipe: SMELT,
      inputs: [],
      outputs: [{ color: PLATE, amount: 1 }],
      craftEvery: 30,
      storageCap: 100,
    })
    src.scheduler.runTicks(src.world, 200)

    const dst = await bootstrapSim(6, { startScene: false })
    dst.restore(src.serialize())

    expect(hashSim(dst)).toBe(hashSim(src))
    expect(serializeGameState(dst.state)).toEqual(serializeGameState(src.state))
    const b = buildingAt(dst.state.buildings, 20, 20)
    expect(dst.state.buildings.recipe[b]).toBe(SMELT)
  })
})
