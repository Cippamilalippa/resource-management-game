# Factory Game

A single-player 2D top-down factory / management game. This repository is currently
a **foundation skeleton only** — a clean monorepo with a working "tick + render"
loop. No gameplay (belts, recipes, cities, demand) is implemented yet.

## Quick start

```bash
pnpm install        # install workspace deps
pnpm dev            # launch the Electron window (Pixi canvas + React overlay)
pnpm headless       # run a deterministic N-tick sim, print a reproducible hash
pnpm test           # run the Vitest suite
pnpm typecheck      # strict TS check across every package
pnpm lint           # ESLint (incl. the no-Date.now/Math.random sim rule)
pnpm format         # Prettier --write
```

`pnpm headless [seed] [ticks]` (defaults: seed `1`, `1000` ticks) boots the sim with a
seed, runs the ticks with no renderer, and prints the final tick/entity counts and a
`stateHash`. The same seed + tick count always prints the same hash.

## Architecture in one screen

```
packages/
  shared/      pure types + utils shared everywhere (GridCoord, lerp, clamp, …)
  engine/      the generic engine — knows NOTHING game-specific
    core/        bitecs world, fixed-timestep scheduler, event bus, seeded RNG, components
    data/        prototype registry + zod schema validation
    scripting/   the stable mod API surface (sandbox internals out of scope)
    render/      PixiJS renderer: reads sim state, interpolates, draws; never writes
    persistence/ deterministic (de)serialization + FNV-1a state hashing
    modloader/   mod manifest shape + dependency resolution + data merge
mods/          ALL game content, discovered by scanning this dir (no privileged path)
  base/        THE BASE GAME = "mod zero" — same shape as any mod (manifest + prototypes + scripts)
  …/           third-party mods drop in here, loaded the exact same way
apps/
  game/        Electron + Pixi + React shell wiring everything together
  headless/    sim-only runner for tests / balancing (no render)
```

### The engine / content boundary (non-negotiable)

The engine has **no concept of "food", "tools", belts or cities**. All game content
arrives as data + scripts through the prototype registry and mod loader. The base game
lives in `mods/base` and is **discovered and loaded as "mod zero"** by the _same_
directory scan + pipeline a third-party mod uses — there is no special-cased path. If
mod discovery ever breaks, the base game won't boot, so the mod system is exercised at
all times. Whatever the base game can do, a modder can too.

Cross-module imports inside the engine go through each module's public `index.ts`
barrel (e.g. `@factory/engine/core`) — never by reaching into internals.

### Invariants that must survive into future work

- **Render/UI never mutate sim state.** The renderer is a pure read of the sim grid.
- **Fixed timestep.** The sim advances in fixed steps (default 60 ticks/s) decoupled
  from the render frame rate; the renderer interpolates between the last two ticks with
  the scheduler's `alpha`.
- **Integer tile grid.** All world coordinates are integers (`Int32Array`). No
  continuous/float positions in the sim.
- **Determinism.** Sim logic uses only the seeded RNG — no `Math.random`, no `Date.now`
  (enforced by ESLint in `engine/core` + `mods/**/scripts`). This protects save/load and
  a possible future multiplayer.
- **Headless-able.** The sim runs with no Pixi and no Electron (see `apps/headless`).
- **Allocation-conscious hot path.** Components are Structure-of-Arrays typed arrays via
  bitecs; the sim does not allocate per-entity objects per tick.

## Tech stack

TypeScript (strict) · Electron · PixiJS v8 · bitecs · React · Vite · Vitest ·
pnpm workspaces · ESLint + Prettier. See per-package `package.json` for pinned versions.

## How `pnpm dev` is wired

The renderer is a normal Vite app (`apps/game/index.html` → `src/main.tsx`). The Electron
main + preload are TypeScript, bundled to CommonJS in `dist-electron/` by esbuild
(`scripts/build-electron.mjs`). `pnpm dev` builds those, starts Vite, waits for the dev
server, then launches Electron pointed at it. The Electron **main** process scans `/mods`
and loads every discovered mod (the base game included) through the real mod loader (it
has filesystem access) and hands the merged prototypes to the sandboxed renderer over a
`contextBridge` IPC bridge.
