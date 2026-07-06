import { describe, it, expect } from 'vitest'
import { buildRateModel, flowPerMinute, formatRate } from '../src/rates.ts'
import type { ClientPrototype } from '../src/sim.ts'

/**
 * A small prototype fixture that mirrors the base-mod shape: raw bauxite mined by a drill, alumina
 * refined from it, and aluminium smelted from alumina — enough to exercise per-minute rates and a
 * one-level machine ratio.
 */
const protos: ClientPrototype[] = [
  { id: 'item.bauxite', type: 'item', color: 0x111111 },
  { id: 'item.alumina', type: 'item', color: 0x222222 },
  { id: 'item.aluminium', type: 'item', color: 0x333333 },
  {
    id: 'building.mining_drill',
    type: 'crafter',
    name: 'Mining Drill',
    craftingCategories: ['mining'],
    speed: 1,
  },
  {
    id: 'building.refinery',
    type: 'crafter',
    name: 'Refinery',
    craftingCategories: ['refining'],
    speed: 1,
  },
  {
    id: 'building.smelter',
    type: 'crafter',
    name: 'Smelter',
    craftingCategories: ['smelting'],
    speed: 2,
  },
  {
    id: 'recipe.bauxite',
    type: 'recipe',
    category: 'mining',
    time: 40,
    ingredients: [],
    results: [{ item: 'item.bauxite', amount: 1 }],
  },
  {
    id: 'recipe.alumina',
    type: 'recipe',
    category: 'refining',
    time: 60,
    ingredients: [{ item: 'item.bauxite', amount: 2 }],
    results: [{ item: 'item.alumina', amount: 1 }],
  },
  {
    id: 'recipe.aluminium',
    type: 'recipe',
    category: 'smelting',
    time: 30,
    ingredients: [{ item: 'item.alumina', amount: 3 }],
    results: [{ item: 'item.aluminium', amount: 1 }],
  },
]

describe('flowPerMinute', () => {
  it('is amount · speed · 3600 / time, at 60 ticks/s', () => {
    expect(flowPerMinute(1, 60, 1)).toBe(60)
    expect(flowPerMinute(2, 40, 1)).toBe(180)
    expect(flowPerMinute(1, 30, 2)).toBe(240) // speed doubles the rate (120 → 240)
  })

  it('returns 0 for a non-positive time', () => {
    expect(flowPerMinute(5, 0, 1)).toBe(0)
    expect(flowPerMinute(5, -10, 1)).toBe(0)
  })
})

describe('formatRate', () => {
  it('trims decimals by magnitude and drops trailing zeros', () => {
    expect(formatRate(12)).toBe('12')
    expect(formatRate(120)).toBe('120')
    expect(formatRate(2.6667)).toBe('2.67')
    expect(formatRate(45.5)).toBe('45.5')
    expect(formatRate(0.125)).toBe('0.13')
    expect(formatRate(0)).toBe('0')
    expect(formatRate(Infinity)).toBe('—')
  })
})

describe('buildRateModel.recipeRates', () => {
  it('reports per-minute in/out rates in authored flow order', () => {
    const model = buildRateModel(protos)
    // Refinery: 60 ticks/craft, consumes 2 bauxite → 1 alumina.
    expect(model.recipeRates('recipe.alumina')).toEqual({ inputs: [120], outputs: [60] })
    // Extraction: no inputs, 1 bauxite every 40 ticks.
    expect(model.recipeRates('recipe.bauxite')).toEqual({ inputs: [], outputs: [90] })
  })

  it('scales output by the crafter speed of the recipe category', () => {
    const model = buildRateModel(protos)
    // Smelter runs at speed 2: 3 alumina in, 1 aluminium out, every 30 ticks.
    expect(model.recipeRates('recipe.aluminium')).toEqual({ inputs: [720], outputs: [240] })
  })

  it('returns empty rates for an unknown recipe', () => {
    expect(buildRateModel(protos).recipeRates('recipe.nope')).toEqual({ inputs: [], outputs: [] })
  })
})

describe('buildRateModel.ratioHints', () => {
  it('gives the direct upstream machine count per ingredient', () => {
    const model = buildRateModel(protos)
    // Aluminium (smelter, speed 2): consumes 3 alumina/craft, 30 ticks → 720/min alumina.
    // Alumina (refinery, speed 1): 1 per 60 ticks → 60/min. Ratio = 720 / 60 = 12 refineries.
    const hints = model.ratioHints('recipe.aluminium')
    expect(hints).toHaveLength(1)
    expect(hints[0]).toMatchObject({
      item: 'item.alumina',
      machineName: 'Refinery',
      color: 0x222222,
      count: 12,
    })
  })

  it('walks only one level deep (alumina → drills, not alumina → refinery → drills)', () => {
    const model = buildRateModel(protos)
    // Alumina consumes 2 bauxite/craft at 60 ticks → 120/min; a drill makes 90/min → 120/90.
    const hints = model.ratioHints('recipe.alumina')
    expect(hints).toHaveLength(1)
    expect(hints[0]?.machineName).toBe('Mining Drill')
    expect(hints[0]?.count).toBeCloseTo(120 / 90, 6)
  })

  it('has no hints for a raw extraction recipe', () => {
    expect(buildRateModel(protos).ratioHints('recipe.bauxite')).toEqual([])
  })

  it('sorts hints by heaviest machine demand first', () => {
    const model = buildRateModel([
      { id: 'item.a', type: 'item', color: 1 },
      { id: 'item.b', type: 'item', color: 2 },
      { id: 'item.out', type: 'item', color: 3 },
      {
        id: 'building.mk',
        type: 'crafter',
        name: 'Maker',
        craftingCategories: ['make', 'a', 'b'],
        speed: 1,
      },
      {
        id: 'recipe.a',
        type: 'recipe',
        category: 'a',
        time: 60,
        ingredients: [],
        results: [{ item: 'item.a', amount: 1 }],
      },
      {
        id: 'recipe.b',
        type: 'recipe',
        category: 'b',
        time: 60,
        ingredients: [],
        results: [{ item: 'item.b', amount: 10 }],
      },
      {
        id: 'recipe.out',
        type: 'recipe',
        category: 'make',
        time: 60,
        ingredients: [
          { item: 'item.a', amount: 1 },
          { item: 'item.b', amount: 1 },
        ],
        results: [{ item: 'item.out', amount: 1 }],
      },
    ])
    const hints = model.ratioHints('recipe.out')
    expect(hints.map((h) => h.item)).toEqual(['item.a', 'item.b']) // a needs 1×, b needs 0.1×
    expect(hints[0]?.count).toBeGreaterThan(hints[1]?.count ?? 0)
  })
})

describe('buildRateModel canonical producer', () => {
  const ambiguous: ClientPrototype[] = [
    { id: 'item.plate', type: 'item', color: 9 },
    { id: 'item.widget', type: 'item', color: 10 },
    {
      id: 'building.mk',
      type: 'crafter',
      name: 'Maker',
      craftingCategories: ['a', 'b', 'w'],
      speed: 1,
    },
    {
      id: 'recipe.plate_b',
      type: 'recipe',
      category: 'b',
      time: 20,
      ingredients: [],
      results: [{ item: 'item.plate', amount: 1 }],
    },
    {
      id: 'recipe.plate_a',
      type: 'recipe',
      category: 'a',
      time: 80,
      ingredients: [],
      results: [{ item: 'item.plate', amount: 1 }],
    },
    {
      id: 'recipe.widget',
      type: 'recipe',
      category: 'w',
      time: 60,
      ingredients: [{ item: 'item.plate', amount: 1 }],
      results: [{ item: 'item.widget', amount: 1 }],
    },
  ]

  it('defaults to the lexicographically smallest recipe id', () => {
    const hints = buildRateModel(ambiguous).ratioHints('recipe.widget')
    // recipe.plate_a (80 ticks → 45/min) is picked over recipe.plate_b; widget wants 60/min.
    expect(hints[0]?.count).toBeCloseTo(60 / 45, 6)
  })

  it('honors a preferredRecipes override', () => {
    const hints = buildRateModel(ambiguous, { 'item.plate': 'recipe.plate_b' }).ratioHints(
      'recipe.widget',
    )
    // recipe.plate_b (20 ticks → 180/min); widget wants 60/min → 1/3.
    expect(hints[0]?.count).toBeCloseTo(60 / 180, 6)
  })
})
