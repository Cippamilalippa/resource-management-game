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
  PlaceCrafterCommand,
  PlaceCannonCommand,
  SetRecipeCommand,
  SetActiveResearchCommand,
  SetPortFilterCommand,
  SetCannonTargetCommand,
  SetCannonEnabledCommand,
  RemoveCommand,
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

/** Queue a crafter placement (applied next tick) — the general recipe-driven form. */
export function enqueuePlaceCrafter(gw: GameWorld, cmd: Omit<PlaceCrafterCommand, 'type'>): void {
  enqueueCommand(gw, { type: 'place_crafter', ...cmd })
}

/** Queue a cargo-cannon placement (applied next tick) — a long-haul artillery building. */
export function enqueuePlaceCannon(gw: GameWorld, cmd: Omit<PlaceCannonCommand, 'type'>): void {
  enqueueCommand(gw, { type: 'place_cannon', ...cmd })
}

/** Queue a cannon→silo link (applied next tick) for the cannon at (x, y). */
export function enqueueSetCannonTarget(
  gw: GameWorld,
  cmd: Omit<SetCannonTargetCommand, 'type'>,
): void {
  enqueueCommand(gw, { type: 'set_cannon_target', ...cmd })
}

/** Queue an auto-fire on/off toggle (applied next tick) for the cannon at (x, y). */
export function enqueueSetCannonEnabled(
  gw: GameWorld,
  cmd: Omit<SetCannonEnabledCommand, 'type'>,
): void {
  enqueueCommand(gw, { type: 'set_cannon_enabled', ...cmd })
}

/** Queue a recipe (re)assignment for the crafter at (x, y) (applied next tick). */
export function enqueueSetRecipe(gw: GameWorld, cmd: Omit<SetRecipeCommand, 'type'>): void {
  enqueueCommand(gw, { type: 'set_recipe', ...cmd })
}

/** Queue a colour-filter (re)assignment for the port at (x, y) (applied next tick). */
export function enqueueSetPortFilter(gw: GameWorld, cmd: Omit<SetPortFilterCommand, 'type'>): void {
  enqueueCommand(gw, { type: 'set_port_filter', ...cmd })
}

/**
 * Queue an *extraction* crafter placement (applied next tick): a convenience over
 * {@link enqueuePlaceCrafter} for the common single-output, no-input case (a farm/mine that
 * makes one unit of `itemColor` every `produceEvery` ticks). It is the host bridge's shorthand
 * — the sim itself only knows the general `place_crafter` command.
 */
export function enqueuePlaceProducer(
  gw: GameWorld,
  cmd: {
    x: number
    y: number
    w: number
    h: number
    color: number
    itemColor: number
    produceEvery: number
    storageCap: number
    requiresTerrainType?: number
  },
): void {
  enqueueCommand(gw, {
    type: 'place_crafter',
    x: cmd.x,
    y: cmd.y,
    w: cmd.w,
    h: cmd.h,
    color: cmd.color,
    inputs: [],
    outputs: [{ color: cmd.itemColor, amount: 1 }],
    craftEvery: cmd.produceEvery,
    storageCap: cmd.storageCap,
    ...(cmd.requiresTerrainType !== undefined
      ? { requiresTerrainType: cmd.requiresTerrainType }
      : {}),
  })
}

/**
 * Queue selection of the technology research works toward (applied next tick). `tech` is the
 * opaque integer id (host-side `techTypeOf`) and `cost` its authored pack requirement; the sim
 * drains labs into it until the cost is met (single-active model).
 */
export function enqueueSetActiveResearch(
  gw: GameWorld,
  cmd: Omit<SetActiveResearchCommand, 'type'>,
): void {
  enqueueCommand(gw, { type: 'set_active_research', ...cmd })
}

/** Queue a removal of whatever deletable object sits at (x, y) (applied next tick). */
export function enqueueRemove(gw: GameWorld, cmd: Omit<RemoveCommand, 'type'>): void {
  enqueueCommand(gw, { type: 'remove', ...cmd })
}

/**
 * Queue an already-assembled command (applied next tick) — the generic form the undo/redo
 * history uses to replay or reverse a recorded gesture. The typed `enqueuePlace*` helpers above
 * are preferred for authoring new placements; this bridge exists for command records that were
 * built once and are re-dispatched verbatim.
 */
export function dispatchCommand(
  gw: GameWorld,
  cmd: { type: string; [key: string]: unknown },
): void {
  enqueueCommand(gw, cmd)
}
