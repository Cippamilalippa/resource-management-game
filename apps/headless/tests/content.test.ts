import { describe, it, expect } from 'vitest'
import { PrototypeRegistry } from '@factory/engine/data'
import { validateContent, buildableSet, allTechIds } from '../gameLogic.ts'

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
