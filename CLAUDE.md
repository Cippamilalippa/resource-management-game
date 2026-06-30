# Claude instructions — Factory Game

Working rules for this repo. Read alongside `README.md` (which explains the
architecture). These are **must-follow**, not suggestions.

## Source control — never commit

**You must never `git commit`, `git push`, create branches, tags, or open PRs.** The
user is solely responsible for all source control. Read-only git is fine (`git status`,
`git diff`, `git log`) but never anything that writes history or touches a remote. Leave
changes in the working tree and tell the user what you changed; let them commit.

## Verification gate — run before claiming any task is done

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm format:check
```

If you touched the sim, also confirm determinism still holds:

```bash
pnpm headless 99 750   # run twice — the stateHash MUST match
```

Never report work as complete on the basis of "it should work". Run the gate and
report the actual result; if something fails or was skipped, say so.

## 1. Testing policy

**Always add tests for the core engine.** Any change to `packages/engine/core`
(scheduler, world, components, RNG, event bus) ships with Vitest coverage.

Tests are also **required** for the other sim-critical / data-integrity modules,
because a silent regression there corrupts saves or breaks reproducibility:

- `engine/data` — registry validation (accept valid, reject invalid/duplicate).
- `engine/persistence` — serialize↔deserialize round-trips and `hashState`.
- `engine/modloader` — dependency ordering, cycle/missing-dep detection, merge.
- `apps/headless` — end-to-end reproducibility (same seed + ticks → same hash).

For any **new sim system**, add a determinism test (same seed + tick count →
identical `hashState`). This is the single most important guarantee in the codebase.

For any **persistence change**, add a serialize→deserialize round-trip test proving
`hashState` is preserved (see `packages/engine/tests/persistence.test.ts`).

**Test layout.** Tests live in a `tests/` folder inside each package/app (e.g.
`packages/engine/tests/`), **never beside the source file**. Vitest only picks up
`packages/**/tests/**/*.test.ts` and `apps/**/tests/**/*.test.ts`.

**Exempt** (no unit tests expected): `engine/render` and the React overlay — they
need a GPU/DOM and contain no sim logic. Keep logic out of them so they stay exempt.

## 2. Performance policy — the engine must stay fast

Target: **thousands of simultaneous entities at 60fps**, with the fixed-timestep
sim loop being CPU-bound. Treat performance as a correctness property of the engine,
not an afterthought.

- **Zero allocation in the per-tick hot path.** No object/array/closure creation
  inside systems or per-entity loops. Reuse buffers; mutate in place.
- **Data-oriented only.** Entity data lives in bitecs Structure-of-Arrays typed
  arrays. Never introduce per-entity JS objects on the hot path.
- **Iterate query results by index** (`for (let i…)`), not `.map`/`.forEach`/spread,
  which allocate or box.
- **Integer math on the grid.** Coordinates are `Int32Array`; avoid float work in
  the sim.
- Keep gameplay logic out of `render/` — render is a per-frame read and must not do
  sim work.
- Don't micro-optimize _logic_ prematurely, but **never allocate in the loop**. When
  a hot path changes, sanity-check cost with the headless runner (it's the perf
  harness): `pnpm headless <seed> <bigN>`.
- **Keep the perf guard green.** `packages/engine/tests/performance.test.ts` asserts a
  per-tick budget over 10k entities; a regression there is a real problem, not a flaky
  test — investigate before relaxing the budget. For precise measurement of the hot
  path, use `pnpm bench` (informational `*.bench.ts`, not run by `pnpm test`).

## 3. Non-negotiable invariants (do not regress)

- **Engine knows nothing game-specific.** No "food"/"tools"/belts/cities in
  `packages/engine`. Game concepts arrive only as data/scripts via the prototype
  registry + mod loader. The base game in `mods/base` is "mod zero" — discovered and
  loaded by the same `/mods` directory scan a third-party mod uses; never special-case it.
  Its `scripts/` reach the engine ONLY through `ModApi` (`registerSystem`, `spawn`,
  `despawn`, `on`, `emit`, `getPrototype`) — no value imports from `@factory/engine/*` in
  the sandboxed sim. The base sim lives in `mods/base/scripts/sim.ts`; `apps/*/src` and the
  headless tests consume its read-only helpers via the thin `gameLogic.ts` re-export barrels
  (a single source of truth — don't reintroduce app-side copies). Each mod is its own pnpm
  workspace package (`mods/*`) so its scripts resolve `@factory/engine` and are covered by
  `pnpm -r typecheck`.
- **Determinism.** Sim code uses the seeded RNG only — no `Math.random`, no
  `Date.now`/`Date` in `engine/core` or `mods/**/scripts` (ESLint enforces this).
- **Render/UI never mutate sim state.** One-way: sim → render.
- **Fixed timestep, integer grid.** The sim advances in fixed steps decoupled from
  frame rate; render interpolates with the scheduler `alpha`. No float positions.
- **Module boundaries.** Import engine modules through their barrels
  (`@factory/engine/core`, …); never reach into internals.
- **Stable mod API.** The `scripting` surface (`ModApi`) is a public contract —
  extend it additively; avoid breaking changes.

## Conventions

- TypeScript strict everywhere; no `any`, no non-null-assertion abuse (the typed-array
  hot paths are the sanctioned exception).
- Pin dependency versions.
- Keep `README.md` commands/invariants in sync if you change the build or the rules.
