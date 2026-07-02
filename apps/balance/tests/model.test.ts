import { describe, expect, it } from 'vitest'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultConfig, type BalanceConfig } from '../config.ts'
import { loadDataset } from '../load.ts'
import { buildModel, machineBill, tierCurve, tierFootprint } from '../model.ts'
import type { Crafter, Dataset, Recipe } from '../types.ts'

/**
 * Build a Dataset from recipes. Each category gets crafters at the given `speeds` (default a
 * single speed-1 machine) — pass several to model a machine-tier ladder (mk1, mk2, …).
 */
function dataset(recipes: Recipe[], items: string[], speeds: number[] = [1]): Dataset {
  const categories = new Set(recipes.map((r) => r.category))
  const crafters: Crafter[] = [...categories].flatMap((cat) =>
    speeds.map((speed, i) => ({
      id: `building.${cat}.mk${i + 1}`,
      name: `${cat} mk${i + 1}`,
      categories: [cat],
      speed,
    })),
  )
  const categorySpeed = new Map([...categories].map((c) => [c, Math.max(...speeds)]))
  const ascending = [...speeds].sort((a, b) => a - b)
  const categoryTiers = new Map<string, readonly number[]>(
    [...categories].map((c) => [c, ascending]),
  )
  return {
    items: new Map(items.map((id) => [id, { id, name: id }])),
    recipes,
    crafters,
    categorySpeed,
    categoryTiers,
  }
}

const CFG: BalanceConfig = { ...defaultConfig, tickRate: 60 }

// A hand-checked chain: ore --2--> plate --2--> gear, at tickRate 60.
const chain: Recipe[] = [
  {
    id: 'r.ore',
    category: 'mining',
    ingredients: [],
    results: [{ item: 'ore', amount: 1 }],
    time: 40,
  },
  {
    id: 'r.plate',
    category: 'smelt',
    ingredients: [{ item: 'ore', amount: 2 }],
    results: [{ item: 'plate', amount: 1 }],
    time: 60,
  },
  {
    id: 'r.gear',
    category: 'asm',
    ingredients: [{ item: 'plate', amount: 2 }],
    results: [{ item: 'gear', amount: 1 }],
    time: 80,
  },
]

describe('raw-cost expansion', () => {
  const model = buildModel(dataset(chain, ['ore', 'plate', 'gear']), CFG)

  it('resolves tiers by depth to a raw leaf', () => {
    expect(model.costs.get('ore')?.tier).toBe(0)
    expect(model.costs.get('plate')?.tier).toBe(1)
    expect(model.costs.get('gear')?.tier).toBe(2)
  })

  it('unfolds embodied raw resources', () => {
    expect([...model.costs.get('gear')!.raw]).toEqual([['ore', 4]])
    expect([...model.costs.get('plate')!.raw]).toEqual([['ore', 2]])
  })

  it('accumulates embodied labor across the whole sub-tree', () => {
    // ore 40/60; plate 60/60 + 2*ore; gear 80/60 + 2*plate.
    expect(model.costs.get('ore')!.laborSeconds).toBeCloseTo(0.6667, 4)
    expect(model.costs.get('plate')!.laborSeconds).toBeCloseTo(2.3333, 4)
    expect(model.costs.get('gear')!.laborSeconds).toBeCloseTo(6, 4)
  })

  it('scores composite as Σ raw · weight', () => {
    expect(model.costs.get('gear')!.composite).toBe(4)
  })

  it('marks the uncosumed good as the terminal', () => {
    expect(model.terminals).toEqual(['gear'])
  })
})

describe('machine bill', () => {
  const data = dataset(chain, ['ore', 'plate', 'gear'])
  const model = buildModel(data, CFG)

  it('sizes each step for a target throughput', () => {
    const bill = new Map(machineBill(data, model, 'gear', 1, CFG).map((s) => [s.item, s.machines]))
    expect(bill.get('gear')).toBeCloseTo(1.3333, 4) // 1 * 80/60
    expect(bill.get('plate')).toBeCloseTo(2, 4) // 2/s * 60/60
    expect(bill.get('ore')).toBeCloseTo(2.6667, 4) // 4/s * 40/60
  })
})

describe('machine-tier footprint', () => {
  it('collapses the machine count as every step upgrades a tier', () => {
    // Two tiers: mk1 speed 1, mk2 speed 2. At mk1 the gear factory needs 6 machines
    // (1.333 gear + 2 plate + 2.667 ore); doubling speed halves that to 3.
    const data = dataset(chain, ['ore', 'plate', 'gear'], [1, 2])
    const model = buildModel(data, CFG)
    const rows = tierFootprint(data, model, 'gear', 1, CFG)
    expect(rows.map((r) => r.label)).toEqual(['mk1', 'mk2'])
    expect(rows[0]!.totalMachines).toBeCloseTo(6, 4)
    expect(rows[0]!.speedup).toBeCloseTo(1, 4)
    expect(rows[1]!.totalMachines).toBeCloseTo(3, 4)
    expect(rows[1]!.speedup).toBeCloseTo(2, 4)
  })

  it('reports a single tier when no machine ladder exists', () => {
    const data = dataset(chain, ['ore', 'plate', 'gear'])
    const rows = tierFootprint(data, buildModel(data, CFG), 'gear', 1, CFG)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.label).toBe('mk1')
  })
})

describe('composite weights', () => {
  it('re-prices goods when a raw is weighted', () => {
    const data = dataset(chain, ['ore', 'plate', 'gear'])
    const weighted = buildModel(data, { ...CFG, rawWeights: { ore: 3 } })
    expect(weighted.costs.get('gear')!.composite).toBe(12) // 4 ore * 3
  })
})

describe('cycle detection', () => {
  it('throws with the offending chain', () => {
    const cyclic: Recipe[] = [
      {
        id: 'r.a',
        category: 'x',
        ingredients: [{ item: 'b', amount: 1 }],
        results: [{ item: 'a', amount: 1 }],
        time: 10,
      },
      {
        id: 'r.b',
        category: 'x',
        ingredients: [{ item: 'a', amount: 1 }],
        results: [{ item: 'b', amount: 1 }],
        time: 10,
      },
    ]
    expect(() => buildModel(dataset(cyclic, ['a', 'b']), CFG)).toThrow(/cycle/)
  })
})

describe('multiple producers', () => {
  const multi: Recipe[] = [
    {
      id: 'r.raw',
      category: 'mine',
      ingredients: [],
      results: [{ item: 'raw', amount: 1 }],
      time: 10,
    },
    {
      id: 'r.a',
      category: 'c',
      ingredients: [{ item: 'raw', amount: 1 }],
      results: [{ item: 'x', amount: 1 }],
      time: 10,
    },
    {
      id: 'r.b',
      category: 'c',
      ingredients: [{ item: 'raw', amount: 2 }],
      results: [{ item: 'x', amount: 1 }],
      time: 10,
    },
  ]

  it('warns and picks the smallest recipe id by default', () => {
    const model = buildModel(dataset(multi, ['raw', 'x']), CFG)
    expect(model.costs.get('x')!.producedBy).toBe('r.a')
    expect(model.warnings.some((w) => w.includes('x:'))).toBe(true)
  })

  it('honors a preferred-recipe override without warning', () => {
    const model = buildModel(dataset(multi, ['raw', 'x']), {
      ...CFG,
      preferredRecipes: { x: 'r.b' },
    })
    expect(model.costs.get('x')!.producedBy).toBe('r.b')
    expect(model.warnings).toHaveLength(0)
  })
})

describe('tier curve', () => {
  it('reports the growth multiplier per tier', () => {
    const rows = tierCurve(buildModel(dataset(chain, ['ore', 'plate', 'gear']), CFG), CFG)
    expect(rows.map((r) => r.tier)).toEqual([0, 1, 2])
    expect(rows[1]!.multiplier).toBe(2) // plate 2 / ore 1
    expect(rows[2]!.multiplier).toBe(2) // gear 4 / plate 2
  })
})

describe('real base-mod prototypes', () => {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../mods/base/prototypes')
  const data = loadDataset(dir)
  const model = buildModel(data, defaultConfig)

  it('loads and costs the shipped aerospace content without cycles', () => {
    expect(data.recipes.length).toBeGreaterThan(0)
    // The rocket is the deep apex; aluminum sheet is a mid-tier stock good.
    expect(model.costs.get('item.rocket')?.tier).toBe(7)
    expect(model.costs.get('item.aluminum_sheet')?.tier).toBe(3)
  })

  it('surfaces the rocket as a terminal good and raws at tier 0', () => {
    expect(model.terminals).toContain('item.rocket')
    expect(model.costs.get('item.bauxite')?.tier).toBe(0)
    expect(model.costs.get('item.crude_oil')?.tier).toBe(0)
  })
})
