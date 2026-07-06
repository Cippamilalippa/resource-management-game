import { describe, it, expect } from 'vitest'
import { filterMuted } from '../src/muteStore.ts'
import { tileKey } from '../src/gameLogic.ts'

describe('filterMuted', () => {
  it('returns every item unchanged when nothing is muted', () => {
    const items = [
      { x: 1, y: 1 },
      { x: 2, y: 2 },
    ]
    expect(filterMuted(items, new Set())).toEqual(items)
  })

  it('drops items whose tile key is in the muted set', () => {
    const items = [
      { x: 1, y: 1, label: 'a' },
      { x: 2, y: 2, label: 'b' },
      { x: 3, y: 3, label: 'c' },
    ]
    const muted = new Set([tileKey(2, 2)])
    expect(filterMuted(items, muted)).toEqual([
      { x: 1, y: 1, label: 'a' },
      { x: 3, y: 3, label: 'c' },
    ])
  })

  it('mutes every item sharing a tile, independent of any other field', () => {
    const items = [
      { x: 5, y: 5, kind: 'crafter_missing_input' },
      { x: 5, y: 5, kind: 'crafter_output_full' },
    ]
    const muted = new Set([tileKey(5, 5)])
    expect(filterMuted(items, muted)).toEqual([])
  })

  it('returns a fresh array (never the original reference) even when nothing matches', () => {
    const items = [{ x: 1, y: 1 }]
    const out = filterMuted(items, new Set([tileKey(9, 9)]))
    expect(out).toEqual(items)
    expect(out).not.toBe(items)
  })
})
