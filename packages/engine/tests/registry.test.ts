import { describe, it, expect } from 'vitest'
import { PrototypeRegistry, PrototypeError } from '../data/index.ts'

describe('PrototypeRegistry', () => {
  it('accepts a valid prototype and looks it up', () => {
    const reg = new PrototypeRegistry()
    reg.register({ id: 'item.iron', type: 'item', stackSize: 100 })
    expect(reg.has('item.iron')).toBe(true)
    expect(reg.require('item.iron').stackSize).toBe(100)
    expect(reg.size).toBe(1)
  })

  it('preserves content-defined fields the engine does not know about', () => {
    const reg = new PrototypeRegistry()
    const proto = reg.register({ id: 'x', type: 'recipe', custom: { nested: true } })
    expect(proto.custom).toEqual({ nested: true })
  })

  it('rejects a prototype missing required fields', () => {
    const reg = new PrototypeRegistry()
    expect(() => reg.register({ id: 'no-type' })).toThrow(PrototypeError)
    expect(() => reg.register({ type: 'no-id' })).toThrow(PrototypeError)
    expect(() => reg.register({ id: '', type: 'item' })).toThrow(PrototypeError)
    expect(reg.size).toBe(0)
  })

  it('rejects duplicate ids', () => {
    const reg = new PrototypeRegistry()
    reg.register({ id: 'dup', type: 'item' })
    expect(() => reg.register({ id: 'dup', type: 'item' })).toThrow(/Duplicate/)
  })

  it('filters by type', () => {
    const reg = new PrototypeRegistry()
    reg.register({ id: 'a', type: 'item' })
    reg.register({ id: 'b', type: 'building' })
    reg.register({ id: 'c', type: 'item' })
    expect(reg.listByType('item').map((p) => p.id)).toEqual(['a', 'c'])
  })
})
