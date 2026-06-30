import { describe, it, expect } from 'vitest'
import {
  PrototypeRegistry,
  PrototypeError,
  topologicalOrder,
  assertAcyclic,
  validateReferences,
  type Prototype,
} from '../data/index.ts'

interface Node {
  id: string
  deps: string[]
}
const idOf = (n: Node): string => n.id
const depsOf = (n: Node): string[] => n.deps

describe('topologicalOrder', () => {
  it('orders every node after its dependencies', () => {
    const nodes: Node[] = [
      { id: 'c', deps: ['b'] },
      { id: 'a', deps: [] },
      { id: 'b', deps: ['a'] },
    ]
    const order = topologicalOrder(nodes, idOf, depsOf).map(idOf)
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'))
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('c'))
  })

  it('handles a diamond without duplicating nodes', () => {
    const nodes: Node[] = [
      { id: 'top', deps: ['l', 'r'] },
      { id: 'l', deps: ['base'] },
      { id: 'r', deps: ['base'] },
      { id: 'base', deps: [] },
    ]
    const order = topologicalOrder(nodes, idOf, depsOf).map(idOf)
    expect(order).toHaveLength(4)
    expect(order.indexOf('base')).toBe(0)
    expect(order.indexOf('top')).toBe(3)
  })

  it('throws on a dependency cycle and names the chain', () => {
    const nodes: Node[] = [
      { id: 'a', deps: ['b'] },
      { id: 'b', deps: ['a'] },
    ]
    expect(() => topologicalOrder(nodes, idOf, depsOf)).toThrow(PrototypeError)
    expect(() => topologicalOrder(nodes, idOf, depsOf)).toThrow(/cycle/i)
  })

  it('detects a self-cycle', () => {
    const nodes: Node[] = [{ id: 'a', deps: ['a'] }]
    expect(() => topologicalOrder(nodes, idOf, depsOf)).toThrow(/cycle/i)
  })

  it('throws on a missing dependency by default', () => {
    const nodes: Node[] = [{ id: 'a', deps: ['ghost'] }]
    expect(() => topologicalOrder(nodes, idOf, depsOf)).toThrow(/Missing dependency: "ghost"/)
  })

  it('ignores missing dependencies when asked', () => {
    const nodes: Node[] = [{ id: 'a', deps: ['ghost'] }]
    const order = topologicalOrder(nodes, idOf, depsOf, { onMissing: 'ignore' }).map(idOf)
    expect(order).toEqual(['a'])
  })

  it('rejects duplicate node ids', () => {
    const nodes: Node[] = [
      { id: 'a', deps: [] },
      { id: 'a', deps: [] },
    ]
    expect(() => topologicalOrder(nodes, idOf, depsOf)).toThrow(/Duplicate node id/)
  })
})

describe('assertAcyclic', () => {
  it('passes a DAG and throws a cycle', () => {
    expect(() => assertAcyclic([{ id: 'a', deps: [] }] as Node[], idOf, depsOf)).not.toThrow()
    expect(() => assertAcyclic([{ id: 'a', deps: ['a'] }] as Node[], idOf, depsOf)).toThrow(
      PrototypeError,
    )
  })
})

describe('validateReferences', () => {
  // A minimal recipe-like graph used purely to exercise the generic checker; the
  // engine itself has no notion of recipes — the field selectors live in the test.
  const build = (): PrototypeRegistry => {
    const reg = new PrototypeRegistry()
    reg.register({ id: 'item.ore', type: 'item' })
    reg.register({ id: 'item.plate', type: 'item' })
    return reg
  }
  const selectIngredients = (p: Prototype): string[] =>
    ((p.ingredients as { item: string }[] | undefined) ?? []).map((i) => i.item)

  it('passes when every reference resolves', () => {
    const reg = build()
    reg.register({
      id: 'recipe.plate',
      type: 'recipe',
      ingredients: [{ item: 'item.ore' }],
    })
    expect(() =>
      validateReferences(reg, [
        { type: 'recipe', select: selectIngredients, expectType: 'item', label: 'ingredient' },
      ]),
    ).not.toThrow()
  })

  it('throws on a dangling reference', () => {
    const reg = build()
    reg.register({
      id: 'recipe.bad',
      type: 'recipe',
      ingredients: [{ item: 'item.ghost' }],
    })
    expect(() =>
      validateReferences(reg, [{ type: 'recipe', select: selectIngredients, label: 'ingredient' }]),
    ).toThrow(/recipe\.bad: ingredient "item\.ghost" does not exist/)
  })

  it('throws when a reference resolves to the wrong type', () => {
    const reg = build()
    reg.register({ id: 'building.furnace', type: 'building' })
    reg.register({
      id: 'recipe.bad',
      type: 'recipe',
      ingredients: [{ item: 'building.furnace' }],
    })
    expect(() =>
      validateReferences(reg, [
        { type: 'recipe', select: selectIngredients, expectType: 'item', label: 'ingredient' },
      ]),
    ).toThrow(/must be a "item", got "building"/)
  })

  it('only checks prototypes of the named type', () => {
    const reg = build()
    reg.register({ id: 'other.thing', type: 'other', ingredients: [{ item: 'item.ghost' }] })
    expect(() =>
      validateReferences(reg, [{ type: 'recipe', select: selectIngredients }]),
    ).not.toThrow()
  })
})
