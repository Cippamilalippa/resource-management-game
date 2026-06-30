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
import { createGameState, createGameSystems } from './sim.ts'
import { spawnScene } from './scene.ts'

export default function init(api: ModApi): void {
  const state = createGameState()
  spawnScene(api, state)
  for (const system of createGameSystems(state, api)) api.registerSystem(system)
  // Hand the host a read-only handle to the live state (sim → render, one-way).
  api.emit('base:ready', state)
  api.log('base game init — registered command + belt systems')
}
