import { describe, expect, it } from 'vitest'
import { computeItemPrices, type PriceRecipe } from '../pricing.ts'

// A hand-checked chain at tickRate 60: ore (extraction, 40t) --2--> plate (60t) --2--> gear (80t).
const chain: PriceRecipe[] = [
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

describe('computeItemPrices', () => {
  it('unfolds composite raw cost and embodied labor down the chain (hand-checked)', () => {
    const prices = computeItemPrices(chain, {})
    // ore: composite 1, labor 40/60 = 0.667 → ceil(1 + 0.5·0.667) = 2
    expect(prices.get('ore')).toMatchObject({ composite: 1 })
    expect(prices.get('ore')!.laborSeconds).toBeCloseTo(0.6667, 3)
    expect(prices.get('ore')!.price).toBe(2)
    // plate: composite 2, labor 1 + 2·0.667 = 2.333 → ceil(2 + 1.1667) = 4
    expect(prices.get('plate')!.composite).toBe(2)
    expect(prices.get('plate')!.laborSeconds).toBeCloseTo(2.3333, 3)
    expect(prices.get('plate')!.price).toBe(4)
    // gear: composite 4, labor 80/60 + 2·2.333 = 6 → ceil(4 + 3) = 7
    expect(prices.get('gear')!.composite).toBe(4)
    expect(prices.get('gear')!.laborSeconds).toBeCloseTo(6, 3)
    expect(prices.get('gear')!.price).toBe(7)
  })

  it('honours laborWeight 0 (price = composite, rounded up, ≥ 1)', () => {
    const prices = computeItemPrices(chain, { laborWeight: 0 })
    expect(prices.get('ore')!.price).toBe(1)
    expect(prices.get('plate')!.price).toBe(2)
    expect(prices.get('gear')!.price).toBe(4)
  })

  it('weights a precious raw through the whole sub-tree', () => {
    const prices = computeItemPrices(chain, { laborWeight: 0, rawWeights: { ore: 3 } })
    expect(prices.get('gear')!.price).toBe(12) // 4 embodied ore × 3
  })

  it('divides craft time by the category speed (faster machines → cheaper labor)', () => {
    const slow = computeItemPrices(chain, {})
    const fast = computeItemPrices(chain, {
      categorySpeed: new Map([
        ['mining', 2],
        ['smelt', 2],
        ['asm', 2],
      ]),
    })
    expect(fast.get('gear')!.laborSeconds).toBeCloseTo(slow.get('gear')!.laborSeconds / 2, 6)
  })

  it('shares a multi-result recipe time across its yield and prices co-products', () => {
    const refinery: PriceRecipe[] = [
      {
        id: 'r.crude',
        category: 'drill',
        ingredients: [],
        results: [{ item: 'crude', amount: 1 }],
        time: 45,
      },
      {
        id: 'r.distill',
        category: 'refine',
        ingredients: [{ item: 'crude', amount: 3 }],
        results: [
          { item: 'naphtha', amount: 2 },
          { item: 'kerosene', amount: 1 },
        ],
        time: 60,
      },
    ]
    const prices = computeItemPrices(refinery, {})
    // naphtha: 3 crude / 2 out = 1.5 composite; kerosene: 3 crude / 1 out = 3 composite.
    expect(prices.get('naphtha')!.composite).toBeCloseTo(1.5, 6)
    expect(prices.get('kerosene')!.composite).toBeCloseTo(3, 6)
    expect(prices.get('naphtha')!.price).toBeGreaterThanOrEqual(1)
  })

  it('treats an ingredient no recipe produces as a raw leaf at its weight', () => {
    const lone: PriceRecipe[] = [
      {
        id: 'r.widget',
        category: 'asm',
        ingredients: [{ item: 'mystery', amount: 4 }],
        results: [{ item: 'widget', amount: 1 }],
        time: 60,
      },
    ]
    const prices = computeItemPrices(lone, { laborWeight: 0 })
    expect(prices.get('widget')!.price).toBe(4) // 4 × default weight 1
    expect(prices.has('mystery')).toBe(false) // pure raws are the caller's default
  })

  it('resolves a multi-producer item deterministically and honours the override', () => {
    const multi: PriceRecipe[] = [
      {
        id: 'r.cheap',
        category: 'c',
        ingredients: [{ item: 'raw', amount: 1 }],
        results: [{ item: 'x', amount: 1 }],
        time: 10,
      },
      {
        id: 'r.dear',
        category: 'c',
        ingredients: [{ item: 'raw', amount: 5 }],
        results: [{ item: 'x', amount: 1 }],
        time: 10,
      },
    ]
    const byDefault = computeItemPrices(multi, { laborWeight: 0 })
    expect(byDefault.get('x')!.price).toBe(1) // 'r.cheap' wins lexicographically
    const pinned = computeItemPrices(multi, { laborWeight: 0, preferredRecipes: { x: 'r.dear' } })
    expect(pinned.get('x')!.price).toBe(5)
  })

  it('throws on a recipe cycle', () => {
    const cyclic: PriceRecipe[] = [
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
    expect(() => computeItemPrices(cyclic, {})).toThrow(/cycle/)
  })

  it('always yields an integer price of at least 1', () => {
    const prices = computeItemPrices(chain, {})
    for (const [, p] of prices) {
      expect(Number.isInteger(p.price)).toBe(true)
      expect(p.price).toBeGreaterThanOrEqual(1)
    }
  })
})
