import { createWorld, addEntity, addComponent, removeEntity, query, type World } from 'bitecs'
import type { GridCoord } from '@factory/shared'
import { createComponents, type Components } from './components.ts'
import { EventBus } from './eventBus.ts'
import { SeededRng } from './rng.ts'

/**
 * A deferred player/UI intent, applied by a system at the next tick boundary
 * rather than mutating sim state immediately. The engine treats commands as
 * opaque (`type` + arbitrary payload); content/mods define and interpret them.
 * This is what lets the UI request changes (e.g. "place a building") without
 * ever touching the component arrays directly, keeping the sim the sole writer
 * and the whole flow deterministic.
 */
export interface Command {
  readonly type: string
  readonly [key: string]: unknown
}

/**
 * A GameWorld bundles everything one simulation instance needs. It is fully
 * self-contained (its own component stores, RNG and event bus) so that creating
 * a second world — in a test, a headless balance run, etc. — never aliases the
 * first.
 */
export interface GameWorld {
  /** The underlying bitecs world (entity bookkeeping only). */
  readonly world: World
  /** Per-world Structure-of-Arrays component stores. */
  readonly components: Components
  /** Deterministic PRNG — the only source of randomness allowed in the sim. */
  readonly rng: SeededRng
  /** Synchronous typed event bus. */
  readonly events: EventBus
  /** The seed the world was created with (kept for serialization). */
  readonly seed: number
  /** Logical tick counter; advanced by the scheduler. */
  tick: number
  /**
   * Pending player/UI commands, drained by a system each tick. The engine never
   * interprets these; a content-supplied system reads and applies them.
   */
  readonly commands: Command[]
  /** Lightweight stats, handy for tests and the debug overlay. */
  readonly stats: { systemRuns: number }
}

/** Create an empty, isolated world for the given seed. */
export function createGameWorld(seed: number): GameWorld {
  return {
    world: createWorld(),
    components: createComponents(),
    rng: new SeededRng(seed),
    events: new EventBus(),
    seed: seed >>> 0,
    tick: 0,
    commands: [],
    stats: { systemRuns: 0 },
  }
}

/**
 * Submit a deferred command. The sanctioned way for UI/scripts to request a sim
 * change: it is queued, then applied by a system at the next tick (never mutating
 * component state inline), which keeps the sim deterministic and the renderer a
 * pure reader.
 */
export function enqueueCommand(gw: GameWorld, command: Command): void {
  gw.commands.push(command)
}

/**
 * Spawn an entity with Position + Renderable. This is the generic primitive used
 * by content/mods; the engine attaches no game meaning to the values.
 */
export function spawnEntity(
  gw: GameWorld,
  opts: {
    pos: GridCoord
    sprite?: number
    color?: number
    width?: number
    height?: number
  },
): number {
  const { Position, Renderable } = gw.components
  const eid = addEntity(gw.world)

  addComponent(gw.world, eid, Position)
  Position.x[eid] = opts.pos.x | 0
  Position.y[eid] = opts.pos.y | 0
  Position.prevX[eid] = opts.pos.x | 0
  Position.prevY[eid] = opts.pos.y | 0

  addComponent(gw.world, eid, Renderable)
  Renderable.sprite[eid] = opts.sprite ?? 0
  Renderable.color[eid] = (opts.color ?? 0xffffff) >>> 0
  Renderable.width[eid] = opts.width ?? 1
  Renderable.height[eid] = opts.height ?? 1

  return eid
}

/** Remove an entity from the world. */
export function despawnEntity(gw: GameWorld, eid: number): void {
  removeEntity(gw.world, eid)
}

/**
 * All entities that currently have both Position and Renderable.
 *
 * Returns bitecs' live query result (a typed array) — iterate it by index in hot
 * paths so no per-frame array is allocated.
 */
export function renderableEntities(gw: GameWorld): ReturnType<typeof query> {
  return query(gw.world, [gw.components.Position, gw.components.Renderable])
}

/** Count of entities carrying a Position (used by the debug overlay). */
export function entityCount(gw: GameWorld): number {
  return query(gw.world, [gw.components.Position]).length
}
