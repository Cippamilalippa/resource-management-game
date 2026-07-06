import { describe, it, expect, beforeEach } from 'vitest'
import { buildEncyclopedia } from '../src/encyclopedia.ts'
import { productionHistory } from '../src/productionHistory.ts'
import type { MachineIndex, MachineDef, RecipeChoice } from '../src/machines.ts'

/** A minimal RecipeChoice for building a fake machine index. */
function recipe(over: Partial<RecipeChoice> & { id: string; name: string }): RecipeChoice {
  return {
    int: 0,
    category: 'craft',
    inputs: [],
    outputs: [],
    inputRates: [],
    outputRates: [],
    ratios: [],
    craftEvery: 30,
    storageCap: 100,
    outputColor: 0,
    requiresTerrainType: 0,
    ...over,
  }
}

function machineIndex(defs: MachineDef[]): MachineIndex {
  return {
    defs,
    byColor: new Map(defs.map((d) => [d.color, d])),
    recipeByInt: new Map(),
  }
}

describe('buildEncyclopedia', () => {
  it('flattens machine recipes into A→Z entries carrying the machine name', () => {
    const smelter: MachineDef = {
      id: 'smelter',
      name: 'Smelter',
      color: 0x111111,
      w: 2,
      h: 2,
      storage: 100,
      categories: ['smelt'],
      extraction: false,
      recipes: [
        recipe({
          id: 'iron_plate',
          name: 'Iron plate',
          inputs: [{ color: 0xaa0000, amount: 2 }],
          outputs: [{ color: 0xcccccc, amount: 1 }],
          inputRates: [30],
          outputRates: [15],
          craftEvery: 40,
        }),
        recipe({ id: 'copper_plate', name: 'Copper plate' }),
      ],
    }
    const entries = buildEncyclopedia(machineIndex([smelter]))
    expect(entries.map((e) => e.name)).toEqual(['Copper plate', 'Iron plate']) // sorted A→Z
    const iron = entries.find((e) => e.name === 'Iron plate')!
    expect(iron.machineName).toBe('Smelter')
    expect(iron.craftEvery).toBe(40)
    expect(iron.inputs).toEqual([{ color: 0xaa0000, amount: 2, perMin: 30 }])
    expect(iron.outputs).toEqual([{ color: 0xcccccc, amount: 1, perMin: 15 }])
  })

  it('returns nothing when no machine has recipes', () => {
    expect(buildEncyclopedia(machineIndex([]))).toEqual([])
  })
})

describe('productionHistory', () => {
  beforeEach(() => productionHistory.reset())

  it('advances every known colour each push, defaulting absent colours to zero', () => {
    productionHistory.push([{ color: 1, producedPerSec: 5 }])
    productionHistory.push([{ color: 2, producedPerSec: 3 }])
    // Colour 1 was absent in the second push → it decays to 0 while staying aligned.
    expect(productionHistory.series(1)).toEqual([5, 0])
    // Colour 2 only appeared in the second push, so it has a single sample.
    expect(productionHistory.series(2)).toEqual([3])
  })

  it('bumps the version on push and reset for the store snapshot', () => {
    const v0 = productionHistory.getVersion()
    productionHistory.push([{ color: 1, producedPerSec: 1 }])
    expect(productionHistory.getVersion()).toBeGreaterThan(v0)
    const v1 = productionHistory.getVersion()
    productionHistory.reset()
    expect(productionHistory.getVersion()).toBeGreaterThan(v1)
    expect(productionHistory.series(1)).toEqual([])
  })
})
