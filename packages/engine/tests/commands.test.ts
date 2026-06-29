import { describe, it, expect } from 'vitest'
import { createGameWorld, enqueueCommand, Scheduler, type GameWorld } from '@factory/engine/core'

describe('command queue', () => {
  it('a fresh world starts with an empty queue', () => {
    const gw = createGameWorld(1)
    expect(gw.commands).toHaveLength(0)
  })

  it('enqueueCommand appends commands in submission order', () => {
    const gw = createGameWorld(1)
    enqueueCommand(gw, { type: 'a' })
    enqueueCommand(gw, { type: 'b', value: 2 })
    expect(gw.commands.map((c) => c.type)).toEqual(['a', 'b'])
    expect(gw.commands[1]!.value).toBe(2)
  })

  it('a system drains the queue at the tick boundary and leaves it empty', () => {
    const gw = createGameWorld(1)
    const applied: string[] = []
    const drain = (w: GameWorld): void => {
      for (let i = 0; i < w.commands.length; i++) applied.push(w.commands[i]!.type)
      w.commands.length = 0
    }
    const scheduler = new Scheduler([drain])

    enqueueCommand(gw, { type: 'x' })
    enqueueCommand(gw, { type: 'y' })
    scheduler.tick(gw)
    expect(applied).toEqual(['x', 'y'])
    expect(gw.commands).toHaveLength(0)

    // A second tick with nothing queued is a no-op.
    scheduler.tick(gw)
    expect(applied).toEqual(['x', 'y'])
  })
})
