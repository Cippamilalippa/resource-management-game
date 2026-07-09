/**
 * Base game ("mod zero") entry script.
 *
 * This default `init(api)` is the base game, contributed through the SAME stable mod API a
 * third-party mod receives — executed by both hosts via the SAME `runModScripts` seam (the
 * headless runner dynamic-imports it; the Electron app loads a Vite-bundled module). It:
 *
 *   1. creates the mod-owned {@link GameState} (belt grid, terrain layer, building store),
 *   2. spawns the starting scene (village, orchard, terrain patches) through `ModApi`,
 *   3. registers the base systems — command handling then belt/building updates — onto the
 *      fixed-tick schedule, and
 *   4. emits `base:ready` with the state so the host can read it (render interpolation,
 *      the inspector, placement-ghost validation) strictly one-way.
 *
 * The engine stays game-agnostic: nothing here touches engine internals — entity lifecycle
 * goes through `api.spawn`/`api.despawn`, and the schedule through `api.registerSystem`.
 */
import type { ModApi } from '@factory/engine/scripting'
import {
  createGameState,
  createGameSystems,
  loadBlockingTerrain,
  loadGameState,
  loadPriceTable,
  type EntityData,
  type GameState,
  type GameStateSnapshot,
} from './sim.ts'
import { spawnScene, type SceneConfig } from './scene.ts'

/**
 * The save shape the {@link BaseReady.load} closure consumes — structurally the engine's
 * `WorldSnapshot` (its `entities` list plus the opaque per-mod `modState` blob), typed loosely
 * here so the base mod need not import the engine's persistence types. The base game reads its
 * own `GameStateSnapshot` out of `modState.base`.
 */
export interface LoadableSnapshot {
  readonly entities: readonly EntityData[]
  readonly modState: Readonly<Record<string, unknown>>
}

/**
 * The handle the base mod hands the host through `base:ready`. The state is a read-only view
 * (sim → render, one-way); the two closures let the host choose the world's origin — a clean
 * starting scene (`newGame`) or a saved snapshot (`load`) — WITHOUT the base mod spawning either
 * inside `init`, so a load never lands on top of a freshly-spawned scene. Both paths still run
 * through the stable {@link ModApi}, keeping the engine game-agnostic.
 */
export interface BaseReady {
  readonly state: GameState
  /**
   * Populate an empty state with a starting scene (village, orchard, deposits). The optional
   * config picks the scenario to lay out; omitting it uses the default scenario, so older callers
   * (and the load path) keep working — the signature stays additively backwards-compatible.
   */
  readonly newGame: (config?: SceneConfig) => void
  /** Restore a saved state: re-spawn the snapshot's entities and rebuild the stores in place. */
  readonly load: (snapshot: LoadableSnapshot) => void
  /**
   * Supply the colour→credit price table the HOST computed from the recipe DAG (see `content.ts`'s
   * `itemColorPrices`) — the credit economy's price source. Call BEFORE `newGame`/`load`: the scene
   * seeds the starting balance through it, and a legacy per-colour save converts through it. The
   * sim never sees an item id — only this colour-keyed table, like all other colour config.
   */
  readonly setPrices: (
    entries: readonly { readonly color: number; readonly price: number }[],
  ) => void
  /**
   * Supply the terrain ids the player cannot build on (impassable biomes like water — every `terrain`
   * prototype flagged `blocksBuild`; see `content.ts`'s `blockingTerrainIds`). Call BEFORE
   * `newGame`/`load`: the rule is derived from content, not saved, so a load recomputes it from the
   * live registry exactly like the price table. The sim never sees the id — only the hashed type set.
   */
  readonly setBlockingTerrain: (ids: readonly string[]) => void
}

export default function init(api: ModApi): void {
  const state = createGameState()
  for (const system of createGameSystems(state, api)) api.registerSystem(system)
  // Hand the host the live state plus the two origin closures. The host picks exactly one
  // (a new game or a loaded save); `init` itself spawns nothing, so the sim starts empty.
  const ready: BaseReady = {
    state,
    newGame: (config) => spawnScene(api, state, config),
    load: (snapshot) => {
      const blob = snapshot.modState.base as GameStateSnapshot | undefined
      if (blob === undefined) throw new Error('save has no base-mod state to load')
      loadGameState(api, state, snapshot.entities, blob)
    },
    setPrices: (entries) => loadPriceTable(state.prices, entries),
    setBlockingTerrain: (ids) => loadBlockingTerrain(state.blockingTerrain, ids),
  }
  api.emit('base:ready', ready)
  api.log('base game init — registered command + belt systems')
}
