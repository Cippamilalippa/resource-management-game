# Factory Game

A single-player 2D top-down factory / management game. The engine is a generic,
deterministic simulation kernel that knows nothing game-specific; the base game
(conveyor belts, resource-holding buildings, producers, input/output ports, splitters
and terrain gating) ships as **"mod zero"** in `mods/base`, contributing its systems and
command handling through the same stable mod API a third-party mod would use.

## Quick start

```bash
pnpm install        # install workspace deps
pnpm dev            # launch the Electron window (Pixi canvas + React overlay)
pnpm headless       # run a deterministic N-tick sim, print a reproducible hash
pnpm balance        # analyze the production-graph economy (raw costs, curve, ratios)
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
    scripting/   the stable mod API surface (registerSystem/spawn/despawn/on/emit/random/…)
    render/      PixiJS renderer: reads sim state, interpolates, draws; never writes
    persistence/ deterministic (de)serialization + FNV-1a state hashing
    modloader/   mod manifest shape + dependency resolution + data merge + script execution
mods/          ALL game content (each a workspace package), discovered by scanning this dir
  base/        THE BASE GAME = "mod zero" — manifest + prototypes + scripts; its scripts/main.ts
               creates the game state, spawns the scene and registers the sim systems via ModApi
  …/           third-party mods drop in here, loaded the exact same way
apps/
  game/        Electron + Pixi + React shell wiring everything together
  headless/    sim-only runner for tests / balancing (no render)
  balance/     read-only economy analyzer: unfolds recipes to raw cost, flags the
               cost curve, sizes machine ratios (see apps/balance/README.md)
```

### The engine / content boundary (non-negotiable)

The engine has **no concept of "food", "tools", belts or cities**. All game content
arrives as data + scripts through the prototype registry and mod loader. The base game
lives in `mods/base` and is **discovered and loaded as "mod zero"** by the _same_
directory scan + pipeline a third-party mod uses — there is no special-cased path. If
mod discovery ever breaks, the base game won't boot, so the mod system is exercised at
all times. Whatever the base game can do, a modder can too.

The base game reaches the engine **only** through the stable `ModApi`: its
`scripts/main.ts` `init(api)` registers the per-tick systems (`api.registerSystem`),
creates and spawns entities (`api.spawn`/`api.despawn`), draws any randomness from the
world's seeded RNG (`api.random`/`api.randomInt` — never `Math.random`, so determinism
holds), and hands the host a read-only state handle for rendering/inspection via an
`api.emit('base:ready', …)` event — never by importing engine internals. Both hosts run it through the one `runModScripts` seam: the
headless runner dynamic-imports the script; the Electron renderer loads a Vite-bundled
copy. Each mod is a small pnpm workspace package so its scripts resolve `@factory/engine`
and are typechecked by `pnpm -r typecheck`.

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
`contextBridge` IPC bridge. The **renderer** then runs each mod's scripts against the live
world through the same `runModScripts` seam the headless runner uses (resolving the
Vite-bundled script modules, since it has no filesystem) — so the base game's systems come
from `mods/base` in both hosts, in identical order, keeping the two views deterministic.
