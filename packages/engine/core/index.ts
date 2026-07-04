/**
 * engine/core — the generic simulation kernel: ECS world, fixed-timestep
 * scheduler, typed event bus, seeded RNG and the starter components. Knows
 * nothing game-specific.
 */
export { MAX_ENTITIES, DEFAULT_TICK_RATE, TILE_SIZE } from './constants.ts'
export { SeededRng } from './rng.ts'
export { EventBus, type EventMap, type Listener } from './eventBus.ts'
export {
  createComponents,
  type Components,
  type PositionStore,
  type RenderableStore,
  type RenderHintsStore,
} from './components.ts'
export {
  createGameWorld,
  spawnEntity,
  despawnEntity,
  setRenderActive,
  renderableEntities,
  entityCount,
  enqueueCommand,
  type GameWorld,
  type Command,
  type SpawnOptions,
} from './world.ts'
export { Scheduler } from './scheduler.ts'
export { counterSystem, type System } from './systems.ts'
