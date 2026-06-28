import { DEFAULT_TICK_RATE } from './constants.ts'
import type { GameWorld } from './world.ts'
import { renderableEntities } from './world.ts'
import type { System } from './systems.ts'

/**
 * Fixed-timestep scheduler. The sim advances in fixed dt steps decoupled from the
 * render frame rate (an accumulator soaks up the difference). This keeps the sim
 * deterministic regardless of display refresh, and lets the renderer interpolate
 * between the two most recent ticks via the returned `alpha`.
 */
export class Scheduler {
  readonly tickRate: number
  /** Fixed step duration in milliseconds. */
  readonly fixedDtMs: number

  #accumulatorMs = 0
  #systems: readonly System[]
  /** Guard against the "spiral of death" if a frame stalls badly. */
  readonly maxStepsPerFrame: number

  constructor(
    systems: readonly System[],
    opts: { tickRate?: number; maxStepsPerFrame?: number } = {},
  ) {
    this.#systems = systems
    this.tickRate = opts.tickRate ?? DEFAULT_TICK_RATE
    this.fixedDtMs = 1000 / this.tickRate
    this.maxStepsPerFrame = opts.maxStepsPerFrame ?? 8
  }

  /**
   * Advance one logical tick: snapshot positions for interpolation, run every
   * system in order, then bump the tick counter. Call this directly from headless
   * / tests where there is no real clock.
   */
  tick(gw: GameWorld): void {
    snapshotPositions(gw)
    for (const system of this.#systems) {
      system(gw)
    }
    gw.tick += 1
  }

  /** Run exactly `n` ticks. Convenience for headless runs and tests. */
  runTicks(gw: GameWorld, n: number): void {
    for (let i = 0; i < n; i++) {
      this.tick(gw)
    }
  }

  /**
   * Feed real elapsed time (ms) from the render loop. Runs as many fixed ticks as
   * have accumulated and returns the interpolation alpha in [0, 1) for the render
   * layer to blend prev->current positions with.
   */
  advance(gw: GameWorld, frameDeltaMs: number): number {
    this.#accumulatorMs += frameDeltaMs
    let steps = 0
    while (this.#accumulatorMs >= this.fixedDtMs && steps < this.maxStepsPerFrame) {
      this.tick(gw)
      this.#accumulatorMs -= this.fixedDtMs
      steps += 1
    }
    // If we hit the step cap, drop the backlog rather than spiral.
    if (this.#accumulatorMs > this.fixedDtMs) {
      this.#accumulatorMs = this.#accumulatorMs % this.fixedDtMs
    }
    return this.#accumulatorMs / this.fixedDtMs
  }
}

/** Copy current tile positions into the prev* arrays so render can interpolate. */
function snapshotPositions(gw: GameWorld): void {
  const { Position } = gw.components
  const ents = renderableEntities(gw)
  for (let i = 0; i < ents.length; i++) {
    const eid = ents[i]!
    Position.prevX[eid] = Position.x[eid]!
    Position.prevY[eid] = Position.y[eid]!
  }
}
