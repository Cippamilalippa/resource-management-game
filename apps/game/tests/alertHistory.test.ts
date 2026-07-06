import { describe, it, expect } from 'vitest'
import { diffAlerts, foldHistory, type AlertHistoryEntry } from '../src/alertHistoryStore.ts'
import type { Alert } from '../src/gameLogic.ts'

const starved = (x: number, y: number, color = 0x112233): Alert => ({
  kind: 'crafter_missing_input',
  x,
  y,
  color,
})
const declining = (x: number, y: number): Alert => ({ kind: 'village_declining', x, y })

describe('diffAlerts', () => {
  it('reports nothing raised or resolved when the same sources persist', () => {
    const prev = [starved(1, 1)]
    const curr = [starved(1, 1)]
    expect(diffAlerts(prev, curr)).toEqual({ raised: [], resolved: [] })
  })

  it('reports a new source as raised', () => {
    const { raised, resolved } = diffAlerts([], [starved(1, 1)])
    expect(raised).toEqual([starved(1, 1)])
    expect(resolved).toEqual([])
  })

  it('reports a vanished source as resolved', () => {
    const { raised, resolved } = diffAlerts([starved(1, 1)], [])
    expect(raised).toEqual([])
    expect(resolved).toEqual([starved(1, 1)])
  })

  it('keys a source by kind + tile, independent of colour', () => {
    // Same tile/kind, different resource colour: still the same *source* (the tile's crafter),
    // so a colour change alone isn't reported as raised+resolved.
    const { raised, resolved } = diffAlerts([starved(1, 1, 0x111111)], [starved(1, 1, 0x222222)])
    expect(raised).toEqual([])
    expect(resolved).toEqual([])
  })

  it('treats the same tile with a different kind as a distinct source', () => {
    const { raised, resolved } = diffAlerts([starved(1, 1)], [declining(1, 1)])
    expect(raised).toEqual([declining(1, 1)])
    expect(resolved).toEqual([starved(1, 1)])
  })

  it('handles a mix of persisting, raised, and resolved sources', () => {
    const prev = [starved(1, 1), declining(2, 2)]
    const curr = [starved(1, 1), starved(3, 3)]
    const { raised, resolved } = diffAlerts(prev, curr)
    expect(raised).toEqual([starved(3, 3)])
    expect(resolved).toEqual([declining(2, 2)])
  })
})

describe('foldHistory', () => {
  it('prepends raised-then-resolved entries, stamping the given time and ids', () => {
    const { history, nextId } = foldHistory([], [starved(1, 1)], [declining(2, 2)], 1000, 1)
    expect(history).toEqual([
      {
        id: 1,
        kind: 'crafter_missing_input',
        x: 1,
        y: 1,
        color: 0x112233,
        event: 'raised',
        at: 1000,
      },
      {
        id: 2,
        kind: 'village_declining',
        x: 2,
        y: 2,
        color: undefined,
        event: 'resolved',
        at: 1000,
      },
    ])
    expect(nextId).toBe(3)
  })

  it('is a no-op (same reference, unchanged nextId) when nothing changed', () => {
    const existing: readonly AlertHistoryEntry[] = []
    const { history, nextId } = foldHistory(existing, [], [], 1000, 5)
    expect(history).toBe(existing)
    expect(nextId).toBe(5)
  })

  it('caps the log to the most recent 50 entries, most-recent-first', () => {
    let history: readonly AlertHistoryEntry[] = []
    let nextId = 1
    for (let i = 0; i < 60; i++) {
      const next = foldHistory(history, [starved(i, i)], [], i, nextId)
      history = next.history
      nextId = next.nextId
    }
    expect(history.length).toBe(50)
    // Most recent addition (i=59) leads the list.
    expect(history[0]).toMatchObject({ x: 59, y: 59, at: 59 })
    // The oldest surviving entry is from i=10 (60 - 50), the earliest ones fell off.
    expect(history[history.length - 1]).toMatchObject({ x: 10, y: 10, at: 10 })
  })
})
