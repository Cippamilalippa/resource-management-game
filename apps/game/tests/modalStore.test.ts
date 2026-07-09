import { describe, it, expect, beforeEach } from 'vitest'
import { modalStore } from '../src/modalStore.ts'

/**
 * UX1 — the central modal stack that replaced the per-modal `window` Esc listeners (each of which
 * bailed while an input inside the modal had focus, trapping the user). These tests cover the pure
 * stack: registration order, idempotency, and that `closeTop` peels the most-recently-opened modal
 * so Esc closes them one at a time. The DOM glue (`useModal` / `installModalEscape`) is a thin render
 * -layer wrapper over this and needs a browser, so it stays out of the node test env.
 */
describe('modalStore stack', () => {
  beforeEach(() => {
    // The store is a module singleton; drain it so tests don't leak state into each other.
    for (const m of [...modalStore.get()]) modalStore.remove(m.id)
  })

  it('is empty and reports closed initially', () => {
    expect(modalStore.isOpen()).toBe(false)
    expect(modalStore.top()).toBeUndefined()
    expect(modalStore.closeTop()).toBe(false)
  })

  it('tracks the most-recently pushed modal as the top', () => {
    modalStore.push('a', () => {})
    modalStore.push('b', () => {})
    expect(modalStore.isOpen()).toBe(true)
    expect(modalStore.top()?.id).toBe('b')
  })

  it('closeTop peels the topmost modal and returns whether one was closed', () => {
    const closed: string[] = []
    modalStore.push('a', () => closed.push('a'))
    modalStore.push('b', () => closed.push('b'))

    expect(modalStore.closeTop()).toBe(true)
    expect(closed).toEqual(['b'])
    // The store still holds `a`: closeTop only invokes the close fn; the modal removes itself when its
    // own open flag flips (mirrored here).
    modalStore.remove('b')
    expect(modalStore.top()?.id).toBe('a')

    expect(modalStore.closeTop()).toBe(true)
    expect(closed).toEqual(['b', 'a'])
    modalStore.remove('a')
    expect(modalStore.isOpen()).toBe(false)
    expect(modalStore.closeTop()).toBe(false)
  })

  it('re-pushing an id refreshes it and moves it to the top (no duplicates)', () => {
    modalStore.push('a', () => {})
    modalStore.push('b', () => {})
    modalStore.push('a', () => {})
    expect(modalStore.get().map((m) => m.id)).toEqual(['b', 'a'])
    expect(modalStore.top()?.id).toBe('a')
  })

  it('closeTop calls the latest close fn registered for the top id', () => {
    let which = ''
    modalStore.push('a', () => {
      which = 'stale'
    })
    modalStore.push('a', () => {
      which = 'fresh'
    })
    modalStore.closeTop()
    expect(which).toBe('fresh')
  })

  it('remove is a no-op for an unregistered id and notifies subscribers on real changes', () => {
    let ticks = 0
    const unsub = modalStore.subscribe(() => ticks++)
    modalStore.remove('ghost')
    expect(ticks).toBe(0)
    modalStore.push('a', () => {})
    modalStore.remove('a')
    expect(ticks).toBe(2)
    unsub()
  })
})
