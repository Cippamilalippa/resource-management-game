/**
 * @factory/engine — generic 2D factory-sim engine.
 *
 * The engine knows NOTHING game-specific. It has no concept of "food", "tools",
 * belts or cities. All game content arrives as data + scripts through the
 * mod loader / prototype registry — the same surface a third-party modder uses.
 *
 * Public modules (import from the subpath barrels, e.g. `@factory/engine/core`):
 *   - core         ECS world, fixed-timestep scheduler, event bus, seeded RNG
 *   - data         prototype registry + runtime schema validation
 *   - scripting    stable mod API surface (sandbox internals are out of scope)
 *   - render       PixiJS read-only renderer with camera + interpolation
 *   - persistence  deterministic (de)serialization + state hashing
 *   - modloader    manifest shape + dependency resolution + data merge
 */
export * from './core/index.ts'
export * from './data/index.ts'
export * from './scripting/index.ts'
export * from './persistence/index.ts'
export * from './modloader/index.ts'
// NOTE: render is intentionally NOT re-exported here so that headless / sim-only
// consumers never transitively pull in PixiJS. Import it via '@factory/engine/render'.
