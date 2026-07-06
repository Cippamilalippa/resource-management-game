import { describe, it, expect, beforeEach } from 'vitest'
import {
  buildEncyclopedia,
  encyclopediaStore,
  filterEncyclopediaByItem,
} from '../src/encyclopedia.ts'
import type { MachineIndex, MachineDef, RecipeChoice } from '../src/machines.ts'

/**
 * Q4 pure-logic coverage: splitting the catalogue into "produces"/"consumes" groups for an item
 * click-through, plus the encyclopedia store's open/filter/clear transitions that drive it.
 */

/** A minimal RecipeChoice for building a fake machine index (mirrors qol.test.ts's helper). */
function recipe(over: Partial<RecipeChoice> & { id: string; name: string }): RecipeChoice {
  return {
    int: 0,
    category: 'craft',
    inputs: [],
    outputs: [],
    craftEvery: 30,
    storageCap: 100,
    outputColor: 0,
    requiresTerrainType: 0,
    ...over,
  }
}

function machineIndex(defs: MachineDef[]): MachineIndex {
  return { defs, byColor: new Map(defs.map((d) => [d.color, d])), recipeByInt: new Map() }
}

const IRON = 0xaa0000
const PLATE = 0xcccccc
const GEAR = 0x00aa00

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
      inputs: [{ color: IRON, amount: 2 }],
      outputs: [{ color: PLATE, amount: 1 }],
    }),
  ],
}
const assembler: MachineDef = {
  id: 'assembler',
  name: 'Assembler',
  color: 0x222222,
  w: 2,
  h: 2,
  storage: 100,
  categories: ['assemble'],
  extraction: false,
  recipes: [
    recipe({
      id: 'gear',
      name: 'Gear',
      inputs: [{ color: PLATE, amount: 1 }],
      outputs: [{ color: GEAR, amount: 1 }],
    }),
  ],
}

describe('filterEncyclopediaByItem', () => {
  const entries = buildEncyclopedia(machineIndex([smelter, assembler]))

  it('groups recipes that output the item under produces', () => {
    const { produces } = filterEncyclopediaByItem(entries, PLATE)
    expect(produces.map((e) => e.name)).toEqual(['Iron plate'])
  })

  it('groups recipes that take the item as input under consumes', () => {
    const { consumes } = filterEncyclopediaByItem(entries, PLATE)
    expect(consumes.map((e) => e.name)).toEqual(['Gear'])
  })

  it('returns empty groups for a colour no recipe touches', () => {
    const result = filterEncyclopediaByItem(entries, 0xdeadbe)
    expect(result.produces).toEqual([])
    expect(result.consumes).toEqual([])
  })
})

describe('encyclopediaStore item filter', () => {
  beforeEach(() => {
    encyclopediaStore.setEntries([])
    encyclopediaStore.close()
    encyclopediaStore.clearItemFilter()
  })

  it('openForItem opens the panel filtered on the given colour', () => {
    encyclopediaStore.openForItem(PLATE)
    expect(encyclopediaStore.get()).toMatchObject({ open: true, itemFilter: PLATE })
  })

  it('clearItemFilter drops the filter without closing the panel', () => {
    encyclopediaStore.openForItem(PLATE)
    encyclopediaStore.clearItemFilter()
    expect(encyclopediaStore.get()).toMatchObject({ open: true, itemFilter: null })
  })

  it('toggling open (E key) from closed clears any stale filter', () => {
    encyclopediaStore.openForItem(PLATE)
    encyclopediaStore.toggle() // closes, but keeps the filter around
    expect(encyclopediaStore.get().itemFilter).toBe(PLATE)
    encyclopediaStore.toggle() // reopens generically — should show the full list again
    expect(encyclopediaStore.get()).toMatchObject({ open: true, itemFilter: null })
  })
})
