import { describe, it, expect, beforeEach } from 'vitest'
import { historyStore, type HistoryCommand } from '../src/historyStore.ts'

/**
 * The undo/redo history is a pure UI-side store: it records the commands that reverse and replay a
 * build gesture and re-dispatches them through an injected sink. These tests pin the linear-history
 * semantics (LIFO undo, redo branch invalidation, refund symmetry) without any sim/DOM.
 */
describe('historyStore', () => {
  let dispatched: HistoryCommand[]

  beforeEach(() => {
    dispatched = []
    historyStore.reset()
    historyStore.setDispatch((cmd) => dispatched.push(cmd))
  })

  const placeStep = (x: number, y: number): void =>
    historyStore.push({
      label: 'building',
      redo: [{ type: 'place_building', x, y }],
      undo: [{ type: 'remove', x, y }],
    })

  it('undo replays the reverse commands; redo replays the forward commands', () => {
    placeStep(3, 4)
    expect(historyStore.get().canUndo).toBe(true)
    expect(historyStore.get().canRedo).toBe(false)

    expect(historyStore.undo()).toBe(true)
    expect(dispatched).toEqual([{ type: 'remove', x: 3, y: 4 }])
    expect(historyStore.get().canUndo).toBe(false)
    expect(historyStore.get().canRedo).toBe(true)

    dispatched = []
    expect(historyStore.redo()).toBe(true)
    expect(dispatched).toEqual([{ type: 'place_building', x: 3, y: 4 }])
    expect(historyStore.get().canUndo).toBe(true)
    expect(historyStore.get().canRedo).toBe(false)
  })

  it('undoes gestures in last-in-first-out order', () => {
    placeStep(1, 1)
    placeStep(2, 2)
    historyStore.undo()
    historyStore.undo()
    expect(dispatched).toEqual([
      { type: 'remove', x: 2, y: 2 },
      { type: 'remove', x: 1, y: 1 },
    ])
  })

  it('pushing a fresh gesture invalidates the redo branch', () => {
    placeStep(1, 1)
    historyStore.undo()
    expect(historyStore.get().canRedo).toBe(true)
    placeStep(9, 9)
    expect(historyStore.get().canRedo).toBe(false)
    expect(historyStore.redo()).toBe(false)
  })

  it('reset clears both stacks', () => {
    placeStep(1, 1)
    historyStore.undo()
    historyStore.reset()
    expect(historyStore.get().canUndo).toBe(false)
    expect(historyStore.get().canRedo).toBe(false)
    expect(historyStore.undo()).toBe(false)
    expect(historyStore.redo()).toBe(false)
  })

  it('ignores an empty gesture', () => {
    historyStore.push({ label: 'nothing', redo: [], undo: [] })
    expect(historyStore.get().canUndo).toBe(false)
  })

  it('surfaces the pending undo/redo labels', () => {
    historyStore.push({
      label: 'Paste',
      redo: [{ type: 'place_belt', ax: 0, ay: 0, bx: 2, by: 0 }],
      undo: [{ type: 'remove', x: 0, y: 0 }],
    })
    expect(historyStore.get().undoLabel).toBe('Paste')
    historyStore.undo()
    expect(historyStore.get().undoLabel).toBe(null)
    expect(historyStore.get().redoLabel).toBe('Paste')
  })
})
