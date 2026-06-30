/**
 * Re-export barrel for the base game's sim logic. The single source of truth now lives in
 * `mods/base/scripts` (the base game runs as "mod zero" through the `ModApi`); this file keeps
 * the renderer/UI importing from one stable local path. The sandboxed sim (`sim.ts`) exposes
 * the read-only helpers the UI needs (belt grid/building/terrain queries, `beltMoveAlpha`,
 * `projectBelt`, …); the host-facing command bridge (`commands.ts`) exposes `enqueuePlace*`.
 */
export * from '../../../mods/base/scripts/sim.ts'
export * from '../../../mods/base/scripts/commands.ts'
