/**
 * The UI→sim command bridge for the base game: thin helpers that enqueue a deferred
 * placement command the base mod's command system applies at the next tick.
 *
 * These belong to the HOST (the build UI, and the headless tests that drive placements),
 * NOT to the sandboxed sim — `enqueueCommand` is the engine's documented, sanctioned way for
 * UI/scripts to request a sim change. They live here, beside the command type definitions in
 * `sim.ts`, so there is a single source of truth shared by both the Electron build UI
 * (`apps/game/src/placement.ts`) and the headless tests, while `sim.ts` itself stays free of
 * engine *value* imports (it reaches the engine only through `ModApi`).
 */
import { enqueueCommand, type GameWorld } from '@factory/engine/core'
import type {
  PlaceBuildingCommand,
  PlaceBeltCommand,
  PlacePortCommand,
  PlaceSplitterCommand,
  PlaceProducerCommand,
} from './sim.ts'

/** Queue a building placement (applied next tick). */
export function enqueuePlaceBuilding(gw: GameWorld, cmd: Omit<PlaceBuildingCommand, 'type'>): void {
  enqueueCommand(gw, { type: 'place_building', ...cmd })
}

/** Queue a belt placement (applied next tick). */
export function enqueuePlaceBelt(gw: GameWorld, cmd: Omit<PlaceBeltCommand, 'type'>): void {
  enqueueCommand(gw, { type: 'place_belt', ...cmd })
}

/** Queue an input/output port placement onto a belt tile (applied next tick). */
export function enqueuePlacePort(gw: GameWorld, cmd: Omit<PlacePortCommand, 'type'>): void {
  enqueueCommand(gw, { type: 'place_port', ...cmd })
}

/** Queue a splitter placement onto a belt tile (applied next tick). */
export function enqueuePlaceSplitter(gw: GameWorld, cmd: Omit<PlaceSplitterCommand, 'type'>): void {
  enqueueCommand(gw, { type: 'place_splitter', ...cmd })
}

/** Queue a production building placement (applied next tick). */
export function enqueuePlaceProducer(gw: GameWorld, cmd: Omit<PlaceProducerCommand, 'type'>): void {
  enqueueCommand(gw, { type: 'place_producer', ...cmd })
}
