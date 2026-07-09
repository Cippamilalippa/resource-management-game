import { describe, it, expect } from 'vitest'
import { PrototypeRegistry } from '@factory/engine/data'
import {
  validateContent,
  itemColorPrices,
  blockingTerrainIds,
  buildableSet,
  allTechIds,
  scenarioList,
} from '../gameLogic.ts'

/**
 * Register a minimal but complete, VALID content set: an item + terrain, one crafter that
 * provides the recipe's category, an extraction recipe, and a technology unlocking both. Tests
 * clone this and corrupt one thing to prove each rule fires.
 */
function validRegistry(): PrototypeRegistry {
  const reg = new PrototypeRegistry()
  reg.register({ id: 'item.ore', type: 'item', color: 1 })
  reg.register({ id: 'item.plate', type: 'item', color: 2 })
  reg.register({ id: 'terrain.rock', type: 'terrain', color: 3 })
  reg.register({
    id: 'building.mine',
    type: 'crafter',
    craftingCategories: ['mining'],
    speed: 1,
    storage: 100,
  })
  reg.register({
    id: 'building.furnace',
    type: 'crafter',
    craftingCategories: ['smelting'],
    speed: 1,
    storage: 100,
  })
  reg.register({
    id: 'recipe.ore',
    type: 'recipe',
    category: 'mining',
    ingredients: [],
    requiresTerrain: 'terrain.rock',
    results: [{ item: 'item.ore', amount: 1 }],
    time: 40,
  })
  reg.register({
    id: 'recipe.plate',
    type: 'recipe',
    category: 'smelting',
    ingredients: [{ item: 'item.ore', amount: 2 }],
    results: [{ item: 'item.plate', amount: 1 }],
    time: 60,
  })
  reg.register({
    id: 'tech.mining',
    type: 'technology',
    prerequisites: [],
    unlocks: ['recipe.ore', 'building.mine'],
  })
  reg.register({
    id: 'tech.smelting',
    type: 'technology',
    prerequisites: ['tech.mining'],
    unlocks: ['recipe.plate', 'building.furnace'],
  })
  return reg
}

describe('validateContent', () => {
  it('accepts well-formed recipe/technology/crafter content', () => {
    expect(() => validateContent(validRegistry())).not.toThrow()
  })

  it('rejects a recipe ingredient that references a missing item', () => {
    const reg = validRegistry()
    reg.register({
      id: 'recipe.bad',
      type: 'recipe',
      category: 'smelting',
      ingredients: [{ item: 'item.ghost', amount: 1 }],
      results: [{ item: 'item.plate', amount: 1 }],
      time: 10,
    })
    expect(() => validateContent(reg)).toThrow(/item\.ghost/)
  })

  it('rejects a recipe whose category no crafter provides', () => {
    const reg = validRegistry()
    reg.register({
      id: 'recipe.orphan',
      type: 'recipe',
      category: 'chemistry',
      ingredients: [],
      results: [{ item: 'item.plate', amount: 1 }],
      time: 10,
    })
    expect(() => validateContent(reg)).toThrow(/category "chemistry"/)
  })

  it('rejects a technology prerequisite cycle', () => {
    const reg = validRegistry()
    reg.register({
      id: 'tech.a',
      type: 'technology',
      prerequisites: ['tech.b'],
      unlocks: ['recipe.ore'],
    })
    reg.register({
      id: 'tech.b',
      type: 'technology',
      prerequisites: ['tech.a'],
      unlocks: ['recipe.plate'],
    })
    expect(() => validateContent(reg)).toThrow(/cycle/i)
  })

  it('rejects a cycle in the recipe production graph (A→B→A)', () => {
    const reg = new PrototypeRegistry()
    reg.register({ id: 'item.a', type: 'item' })
    reg.register({ id: 'item.b', type: 'item' })
    reg.register({
      id: 'building.maker',
      type: 'crafter',
      craftingCategories: ['make'],
      speed: 1,
      storage: 10,
    })
    reg.register({
      id: 'recipe.a',
      type: 'recipe',
      category: 'make',
      ingredients: [{ item: 'item.b', amount: 1 }],
      results: [{ item: 'item.a', amount: 1 }],
      time: 10,
    })
    reg.register({
      id: 'recipe.b',
      type: 'recipe',
      category: 'make',
      ingredients: [{ item: 'item.a', amount: 1 }],
      results: [{ item: 'item.b', amount: 1 }],
      time: 10,
    })
    expect(() => validateContent(reg)).toThrow(/cycle/i)
  })

  it('rejects a malformed recipe (non-positive time)', () => {
    const reg = validRegistry()
    reg.register({
      id: 'recipe.instant',
      type: 'recipe',
      category: 'mining',
      ingredients: [],
      results: [{ item: 'item.ore', amount: 1 }],
      time: 0,
    })
    expect(() => validateContent(reg)).toThrow(/time/)
  })

  it('rejects a technology that unlocks a missing id', () => {
    const reg = validRegistry()
    reg.register({
      id: 'tech.ghost',
      type: 'technology',
      prerequisites: [],
      unlocks: ['recipe.ghost'],
    })
    expect(() => validateContent(reg)).toThrow(/recipe\.ghost/)
  })

  it('accepts a well-formed staged village', () => {
    const reg = validRegistry()
    reg.register({
      id: 'building.village',
      type: 'village',
      accepts: ['item.ore'],
      storage: 100,
      stages: [{ level: 1, population: 10, demands: [{ item: 'item.ore', ratePerMin: 30 }] }],
    })
    expect(() => validateContent(reg)).not.toThrow()
  })

  it('rejects a village whose demand references a missing item', () => {
    const reg = validRegistry()
    reg.register({
      id: 'building.village',
      type: 'village',
      stages: [{ level: 1, population: 10, demands: [{ item: 'item.ghost', ratePerMin: 30 }] }],
    })
    expect(() => validateContent(reg)).toThrow(/item\.ghost/)
  })

  it('rejects a village demand with a non-positive ratePerMin', () => {
    const reg = validRegistry()
    reg.register({
      id: 'building.village',
      type: 'village',
      stages: [{ level: 1, population: 10, demands: [{ item: 'item.ore', ratePerMin: 0 }] }],
    })
    expect(() => validateContent(reg)).toThrow(/ratePerMin/)
  })

  it('accepts a well-formed scenario', () => {
    const reg = validRegistry()
    reg.register({
      id: 'scenario.default',
      type: 'scenario',
      name: 'Default',
      deposits: ['terrain.rock'],
      patchSize: { min: 3, max: 5 },
      spread: { min: 6, max: 16 },
      startingKit: [{ item: 'item.ore', amount: 20 }],
    })
    expect(() => validateContent(reg)).not.toThrow()
  })

  it('rejects a scenario deposit that references a missing terrain', () => {
    const reg = validRegistry()
    reg.register({
      id: 'scenario.bad',
      type: 'scenario',
      deposits: ['terrain.ghost'],
      patchSize: { min: 3, max: 5 },
      spread: { min: 6, max: 16 },
    })
    expect(() => validateContent(reg)).toThrow(/terrain\.ghost/)
  })

  it('rejects a scenario with no deposits', () => {
    const reg = validRegistry()
    reg.register({
      id: 'scenario.empty',
      type: 'scenario',
      deposits: [],
      patchSize: { min: 3, max: 5 },
      spread: { min: 6, max: 16 },
    })
    expect(() => validateContent(reg)).toThrow(/deposits/)
  })

  it('rejects a scenario whose patchSize.min exceeds patchSize.max', () => {
    const reg = validRegistry()
    reg.register({
      id: 'scenario.inverted',
      type: 'scenario',
      deposits: ['terrain.rock'],
      patchSize: { min: 6, max: 3 },
      spread: { min: 6, max: 16 },
    })
    expect(() => validateContent(reg)).toThrow(/patchSize\.min/)
  })

  it('accepts a scenario with a finite richness band (and with it omitted, or "infinite")', () => {
    const finite = validRegistry()
    finite.register({
      id: 'scenario.finite',
      type: 'scenario',
      deposits: ['terrain.rock'],
      patchSize: { min: 3, max: 5 },
      spread: { min: 6, max: 16 },
      richness: { min: 100, max: 500 },
    })
    expect(() => validateContent(finite)).not.toThrow()

    // "infinite" (explicit) and omitted both mean a never-depleting deposit — both valid.
    const infinite = validRegistry()
    infinite.register({
      id: 'scenario.infinite',
      type: 'scenario',
      deposits: ['terrain.rock'],
      patchSize: { min: 3, max: 5 },
      spread: { min: 6, max: 16 },
      richness: 'infinite',
    })
    expect(() => validateContent(infinite)).not.toThrow()
  })

  it('rejects a scenario whose richness.min exceeds richness.max', () => {
    const reg = validRegistry()
    reg.register({
      id: 'scenario.badrich',
      type: 'scenario',
      deposits: ['terrain.rock'],
      patchSize: { min: 3, max: 5 },
      spread: { min: 6, max: 16 },
      richness: { min: 900, max: 100 },
    })
    expect(() => validateContent(reg)).toThrow(/richness\.min/)
  })

  it('rejects a scenario richness that is neither a { min, max } nor "infinite"', () => {
    const reg = validRegistry()
    reg.register({
      id: 'scenario.junkrich',
      type: 'scenario',
      deposits: ['terrain.rock'],
      patchSize: { min: 3, max: 5 },
      spread: { min: 6, max: 16 },
      richness: 'lots',
    })
    expect(() => validateContent(reg)).toThrow(/richness/)
  })

  it('accepts a scenario with worldSize, frequency, and biomes', () => {
    const reg = validRegistry()
    reg.register({
      id: 'scenario.world',
      type: 'scenario',
      deposits: ['terrain.rock'],
      patchSize: { min: 3, max: 5 },
      spread: { min: 6, max: 16 },
      worldSize: { w: 80, h: 80 },
      frequency: { min: 1, max: 3 },
      biomes: [{ terrain: 'terrain.rock', coverage: 100, size: { min: 8, max: 20 } }],
    })
    expect(() => validateContent(reg)).not.toThrow()
  })

  it('rejects a biome that references a missing terrain', () => {
    const reg = validRegistry()
    reg.register({
      id: 'scenario.badbiome',
      type: 'scenario',
      deposits: ['terrain.rock'],
      patchSize: { min: 3, max: 5 },
      spread: { min: 6, max: 16 },
      biomes: [{ terrain: 'terrain.ghost', coverage: 50, size: { min: 8, max: 20 } }],
    })
    expect(() => validateContent(reg)).toThrow(/terrain\.ghost/)
  })

  it('rejects a biome with a malformed size band', () => {
    const reg = validRegistry()
    reg.register({
      id: 'scenario.badbiomesize',
      type: 'scenario',
      deposits: ['terrain.rock'],
      patchSize: { min: 3, max: 5 },
      spread: { min: 6, max: 16 },
      biomes: [{ terrain: 'terrain.rock', coverage: 50, size: { min: 20, max: 8 } }],
    })
    expect(() => validateContent(reg)).toThrow(/biomes\[0\]\.size/)
  })

  it('rejects a malformed worldSize and a malformed frequency', () => {
    const badWorld = validRegistry()
    badWorld.register({
      id: 'scenario.badworld',
      type: 'scenario',
      deposits: ['terrain.rock'],
      patchSize: { min: 3, max: 5 },
      spread: { min: 6, max: 16 },
      worldSize: { w: 0, h: 80 },
    })
    expect(() => validateContent(badWorld)).toThrow(/worldSize/)

    const badFreq = validRegistry()
    badFreq.register({
      id: 'scenario.badfreq',
      type: 'scenario',
      deposits: ['terrain.rock'],
      patchSize: { min: 3, max: 5 },
      spread: { min: 6, max: 16 },
      frequency: { min: 4, max: 2 },
    })
    expect(() => validateContent(badFreq)).toThrow(/frequency\.min/)
  })

  it('blockingTerrainIds lists only terrains flagged blocksBuild', () => {
    const reg = validRegistry()
    reg.register({ id: 'terrain.lake', type: 'terrain', color: 9, blocksBuild: true })
    reg.register({ id: 'terrain.meadow', type: 'terrain', color: 10 })
    const ids = blockingTerrainIds(reg)
    expect(ids).toContain('terrain.lake')
    expect(ids).not.toContain('terrain.meadow')
    expect(ids).not.toContain('terrain.rock') // the base valid registry's terrain isn't blocking.
  })

  it('rejects a scenario starting-kit item that references a missing item', () => {
    const reg = validRegistry()
    reg.register({
      id: 'scenario.badkit',
      type: 'scenario',
      deposits: ['terrain.rock'],
      patchSize: { min: 3, max: 5 },
      spread: { min: 6, max: 16 },
      startingKit: [{ item: 'item.ghost', amount: 5 }],
    })
    expect(() => validateContent(reg)).toThrow(/item\.ghost/)
  })

  it('accepts a scenario with well-formed settlements (a village id + distance band)', () => {
    const reg = validRegistry()
    reg.register({
      id: 'building.camp',
      type: 'village',
      accepts: ['item.ore'],
      storage: 100,
      stages: [{ level: 1, population: 5, demands: [{ item: 'item.ore', ratePerMin: 10 }] }],
    })
    reg.register({
      id: 'scenario.settled',
      type: 'scenario',
      deposits: ['terrain.rock'],
      patchSize: { min: 3, max: 5 },
      spread: { min: 6, max: 16 },
      settlements: [{ building: 'building.camp', distance: { min: 20, max: 30 } }],
    })
    expect(() => validateContent(reg)).not.toThrow()
  })

  it('rejects a settlement that references a missing (or non-village) building', () => {
    const missing = validRegistry()
    missing.register({
      id: 'scenario.ghosttown',
      type: 'scenario',
      deposits: ['terrain.rock'],
      patchSize: { min: 3, max: 5 },
      spread: { min: 6, max: 16 },
      settlements: [{ building: 'building.ghost', distance: { min: 20, max: 30 } }],
    })
    expect(() => validateContent(missing)).toThrow(/building\.ghost/)

    // A crafter is not a village — the settlement must point at a `village` prototype.
    const wrongType = validRegistry()
    wrongType.register({
      id: 'scenario.wrongtype',
      type: 'scenario',
      deposits: ['terrain.rock'],
      patchSize: { min: 3, max: 5 },
      spread: { min: 6, max: 16 },
      settlements: [{ building: 'building.mine', distance: { min: 20, max: 30 } }],
    })
    expect(() => validateContent(wrongType)).toThrow(/building\.mine/)
  })

  it('rejects a settlement with a malformed distance band', () => {
    const reg = validRegistry()
    reg.register({
      id: 'building.camp',
      type: 'village',
      accepts: ['item.ore'],
      stages: [{ level: 1, population: 5, demands: [{ item: 'item.ore', ratePerMin: 10 }] }],
    })
    reg.register({
      id: 'scenario.badband',
      type: 'scenario',
      deposits: ['terrain.rock'],
      patchSize: { min: 3, max: 5 },
      spread: { min: 6, max: 16 },
      settlements: [{ building: 'building.camp', distance: { min: 30, max: 20 } }],
    })
    expect(() => validateContent(reg)).toThrow(/distance\.min/)
  })

  it('rejects a village that demands an item outside its accepts list', () => {
    const reg = validRegistry()
    reg.register({
      id: 'building.village',
      type: 'village',
      accepts: ['item.ore'],
      storage: 100,
      stages: [{ level: 1, population: 10, demands: [{ item: 'item.plate', ratePerMin: 5 }] }],
    })
    // item.plate exists, but the village never stocks it — the demand could never be satisfied.
    expect(() => validateContent(reg)).toThrow(/not in "accepts"/)
  })

  it('rejects a village whose accepts list exceeds the 8 stockpile slots', () => {
    const reg = validRegistry()
    for (let i = 0; i < 9; i++) reg.register({ id: `item.x${i}`, type: 'item', color: 100 + i })
    reg.register({
      id: 'building.hoarder',
      type: 'village',
      accepts: Array.from({ length: 9 }, (_, i) => `item.x${i}`),
      stages: [{ level: 1, population: 10, demands: [{ item: 'item.x0', ratePerMin: 5 }] }],
    })
    expect(() => validateContent(reg)).toThrow(/at most 8/)
  })

  it('accepts a well-formed buildCost on a buildable', () => {
    const reg = validRegistry()
    // A furnace that costs 2 plates to place — the treasury-cost the placement charges.
    reg.register({
      id: 'building.priced_furnace',
      type: 'crafter',
      craftingCategories: ['smelting'],
      speed: 1,
      storage: 100,
      buildCost: [{ item: 'item.plate', amount: 2 }],
    })
    expect(() => validateContent(reg)).not.toThrow()
  })

  it('rejects a buildCost that references a missing item', () => {
    const reg = validRegistry()
    reg.register({
      id: 'building.badcost',
      type: 'crafter',
      craftingCategories: ['smelting'],
      speed: 1,
      storage: 100,
      buildCost: [{ item: 'item.ghost', amount: 1 }],
    })
    expect(() => validateContent(reg)).toThrow(/item\.ghost/)
  })

  it('rejects a buildCost with a non-positive amount', () => {
    const reg = validRegistry()
    reg.register({
      id: 'building.freecost',
      type: 'crafter',
      craftingCategories: ['smelting'],
      speed: 1,
      storage: 100,
      buildCost: [{ item: 'item.plate', amount: 0 }],
    })
    expect(() => validateContent(reg)).toThrow(/amount/)
  })

  it('rejects a scenario startingTreasury item that references a missing item', () => {
    const reg = validRegistry()
    reg.register({
      id: 'scenario.badbank',
      type: 'scenario',
      deposits: ['terrain.rock'],
      patchSize: { min: 3, max: 5 },
      spread: { min: 6, max: 16 },
      startingTreasury: [{ item: 'item.ghost', amount: 5 }],
    })
    expect(() => validateContent(reg)).toThrow(/item\.ghost/)
  })

  it('accepts a non-negative integer upkeep and rejects a malformed one', () => {
    const good = validRegistry()
    good.register({
      id: 'building.kept',
      type: 'crafter',
      craftingCategories: ['smelting'],
      speed: 1,
      storage: 100,
      upkeep: 2,
    })
    expect(() => validateContent(good)).not.toThrow()

    const bad = validRegistry()
    bad.register({
      id: 'building.badkeep',
      type: 'crafter',
      craftingCategories: ['smelting'],
      speed: 1,
      storage: 100,
      upkeep: -1,
    })
    expect(() => validateContent(bad)).toThrow(/upkeep/)
  })
})

describe('itemColorPrices', () => {
  it('prices every item colour from the recipe DAG (hand-checked chain)', () => {
    // validRegistry: ore = extraction (40t, comp 1) → ceil(1 + 0.5·0.667) = 2;
    // plate = 2 ore (60t) → comp 2, labor 1 + 2·0.667 = 2.333 → ceil(2 + 1.167) = 4.
    const prices = new Map(itemColorPrices(validRegistry()).map((p) => [p.color, p.price]))
    expect(prices.get(1)).toBe(2) // item.ore, colour 1
    expect(prices.get(2)).toBe(4) // item.plate, colour 2
  })

  it('prices an item no recipe produces at 1', () => {
    const reg = validRegistry()
    reg.register({ id: 'item.mystery', type: 'item', color: 99 })
    const prices = new Map(itemColorPrices(reg).map((p) => [p.color, p.price]))
    expect(prices.get(99)).toBe(1)
  })

  it('a faster crafter for a category lowers embodied labor (never below 1)', () => {
    const reg = validRegistry()
    reg.register({
      id: 'building.megamine',
      type: 'crafter',
      craftingCategories: ['mining'],
      speed: 4,
      storage: 100,
    })
    const prices = new Map(itemColorPrices(reg).map((p) => [p.color, p.price]))
    // ore labor drops from 0.667s to 0.167s → ceil(1 + 0.083) = 2 still, plate falls to 3.
    expect(prices.get(2)).toBe(3)
  })
})

describe('scenarioList', () => {
  it('projects scenario prototypes to { id, name, info }, ignoring other types', () => {
    const protos = [
      { id: 'item.x', type: 'item' },
      { id: 'scenario.a', type: 'scenario', name: 'Alpha', info: 'first' },
      { id: 'scenario.b', type: 'scenario' },
    ]
    expect(scenarioList(protos)).toEqual([
      { id: 'scenario.a', name: 'Alpha', info: 'first' },
      // Missing name/info fall back to the id / empty string.
      { id: 'scenario.b', name: 'scenario.b', info: '' },
    ])
  })
})

describe('buildableSet', () => {
  const protos = [
    { id: 'tech.a', type: 'technology', unlocks: ['recipe.x', 'building.y'] },
    { id: 'recipe.x', type: 'recipe' },
    { id: 'building.y', type: 'crafter' },
    { id: 'building.z', type: 'building' }, // ungated → always buildable
  ]

  it('gates unlockable ids until their technology is researched', () => {
    const none = buildableSet(protos, new Set())
    expect(none.has('building.z')).toBe(true) // ungated
    expect(none.has('recipe.x')).toBe(false) // gated, not researched
    expect(none.has('building.y')).toBe(false)

    const researched = buildableSet(protos, new Set(['tech.a']))
    expect(researched.has('recipe.x')).toBe(true)
    expect(researched.has('building.y')).toBe(true)
  })

  it('allTechIds collects every technology id (the "all researched" seed)', () => {
    expect(allTechIds(protos)).toEqual(new Set(['tech.a']))
    // Seeding with every tech makes every gated id buildable.
    const all = buildableSet(protos, allTechIds(protos))
    expect(all.has('recipe.x')).toBe(true)
    expect(all.has('building.y')).toBe(true)
  })
})
