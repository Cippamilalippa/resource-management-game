/**
 * Re-export barrel for the base game's sim logic. The single source of truth now lives in
 * `mods/base/scripts` (the base game runs as "mod zero" through the `ModApi`); this file
 * keeps the headless runner's tests importing from one stable local path. The sandboxed sim
 * (`sim.ts`), the host-facing command bridge (`commands.ts`) and the host-side content
 * validation / buildable-set helpers (`content.ts`) are all surfaced here.
 */
export * from '../../mods/base/scripts/sim.ts'
export * from '../../mods/base/scripts/commands.ts'
export * from '../../mods/base/scripts/content.ts'
export * from '../../mods/base/scripts/hud.ts'
