import type { GameWorld } from './world.ts'

/**
 * A System is a pure function of the world that may mutate sim state. Systems run
 * once per logical tick, in array order, inside the fixed-timestep scheduler.
 */
export type System = (gw: GameWorld) => void

/**
 * Trivial starter system: increments a counter and emits a `tick` event. Its only
 * job is to prove the scheduler actually drives systems each tick — real gameplay
 * systems (belts, assemblers, …) are out of scope for this pass.
 */
export const counterSystem: System = (gw) => {
  gw.stats.systemRuns += 1
  gw.events.emit('tick', gw.tick)
}
