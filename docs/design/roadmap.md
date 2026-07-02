# Roadmap — Factory Game

A living, whole-game roadmap. Organised as **macro tasks** (epics) each broken into
**micro tasks**. Ordering is priority, not a promise of sequence — but the near-term
tiers (M1–M7) are gated behind the driving milestone: a **playable vertical slice**, a
cohesive single-player loop you can sit and play end-to-end (build → automate → research →
grow villages) and save/resume.

> **Every micro task passes the verification gate before it counts as done:**
> `pnpm typecheck && pnpm lint && pnpm test && pnpm format:check`, plus
> `pnpm headless 99 750` run twice (matching `stateHash`) whenever the sim changes.
> New sim systems ship a determinism test; persistence changes ship a
> serialize→deserialize round-trip test. See [CLAUDE.md](../../CLAUDE.md).

Legend: `[ ]` todo · `[~]` in progress · `[x]` done.

---

## Done (baseline)

Economy design phases 1–4 (see [economy.md §7](./economy.md)):

- [x] Engine validation primitives (`topologicalOrder` / `assertAcyclic` / `validateReferences`).
- [x] Data refactor to a generic recipe-driven `crafter` (`runCrafters`).
- [x] First production chain + 4-node tech tree (authored + gate-validated).
- [x] Village system (staged demand, buffer, decline timer, floored at level 1).
- [x] In-process deterministic mod script sandbox (`runModScripts` via `ModApi`, both hosts wired).
- [x] Engine persistence primitives (`serialize` / `deserialize` / `hashState`, `SNAPSHOT_VERSION = 1`).

---

# Milestone: Playable Vertical Slice (M1–M7)

## M1 — Runtime research loop

_The explicit next follow-up (economy.md §6.3). Today every tech is seeded as researched;
`cost` is authored but never consumed. This turns progression into gameplay._

- [x] Add a `research` crafter category (the `workshop` maker) + a `lab` building prototype in
      [buildings.json](../../mods/base/prototypes/buildings.json). _(Separate maker + consumer
      lab: the workshop crafts packs, the lab consumes them — see M1 decision below.)_
- [x] Author research-pack item(s) in [items.json](../../mods/base/prototypes/items.json)
      and a recipe that produces them.
- [x] Define the research-progress model: a `ResearchStore` (active tech, accumulated
      packs, completed set, lab anchors) analogous to `VillageStore` in
      [sim.ts](../../mods/base/scripts/sim.ts).
- [x] Add a `researchSystem` (slow cadence) that drains packs from labs into the active
      tech until `cost` is met, then marks it complete and goes idle.
- [x] Replace the "seed all techs as researched" shim (see
      [main.tsx](../../apps/game/src/main.tsx)) with the live `researchedIds`
      feeding `buildableSet` (root/no-prereq techs seeded; the rest earned).
- [x] Command: `set_active_research` (single-active select of the tech to research).
- [x] **Test:** determinism test for `researchSystem` (same seed + ticks → same completed set).
- [x] **Test:** `ResearchStore` serialize→deserialize round-trip (fields preserved). _(Full
      `WorldSnapshot`/app-save integration deferred to M2 per the open decision below.)_

**M1 decisions settled:** single active tech (no queue); separate maker (`workshop`, category
`research`) + consumer `lab`; M1 does a `ResearchStore`-local round-trip only. A host-side stopgap
auto-selects the next researchable tech until the M4 research screen lands.

## M2 — Save / Load & session lifecycle

_Engine can (de)serialize + hash, but no app flow exists. A slice must persist a session._

- [x] **Settled:** save transport is a main-process `fs` write of the `WorldSnapshot` JSON to
      `userData/saves/<id>.factorysave` (a `{ fileVersion, meta, snapshot }` envelope), driven by
      the sandboxed renderer over IPC. The main process owns the slot model; the renderer holds no
      disk access. See [saves.ts](../../apps/game/electron/saves.ts).
- [x] Include mod-side stores (belts, buildings, terrain, village, research) in the snapshot
      via an opaque per-mod `modState` hook (`WorldSnapshot.modState`, hashed by the engine
      but never interpreted). The base mod owns its `serializeGameState`/`loadGameState`; load
      re-spawns entities from the snapshot and links stores by tile, so nothing sim-critical is
      dropped. `init` now publishes new-game/load closures so a load never doubles the scene.
- [x] IPC: `listSaves` / `saveGame` / `loadGame` / `deleteSave` / `renameSave` in Electron main +
      preload ([main.ts](../../apps/game/electron/main.ts), [preload.ts](../../apps/game/electron/preload.ts)).
      The renderer's `createSim` is origin-aware (`new` | `load`) and exposes `serialize()`; a load
      swaps the running session in place (placement re-points, the renderer reconciles entities).
- [x] Autosave on a cadence (3 min) + best-effort on quit; keeps the last N `auto` slots (the main
      process prunes older ones on each write). See the boot loop in [main.tsx](../../apps/game/src/main.tsx).
- [x] Save/load UI ([SaveMenu.tsx](../../apps/game/src/SaveMenu.tsx)): a modal slot list with
      metadata (name, kind badge, tick, timestamp, version), quicksave/quickload (F5/F9), named
      manual saves, overwrite/delete, new-game, and a corner toast. The sim pauses while it is open.
- [~] `SNAPSHOT_VERSION` migration: incompatible saves are now **rejected gracefully** (flagged in
  the list, load blocked with a message). An upgrade/migration seam for older versions is still
  to come.
- [x] **Test:** full round-trip incl. mod stores preserves `hashState`; continuing a
      loaded save for N ticks matches a never-saved run (headless).
      _(`apps/headless/tests/persistence.test.ts`; `pnpm headless` now hashes mod state too.)_

## M3 — Content depth (chains, tech, village ladder)

_Content is thin: 7 recipes, 4 techs. A satisfying slice needs a real progression curve._

- [ ] Expand the production graph: 2–3 more tiers of intermediate + final goods
      ([recipes.json](../../mods/base/prototypes/recipes.json)), staying a strict DAG.
- [ ] Grow the tech tree to gate those tiers meaningfully
      ([technologies.json](../../mods/base/prototypes/technologies.json)).
- [ ] Wire the village demand ladder to the new goods so higher stages pull higher tiers.
- [ ] Author starting-scenario resources/terrain so the early game has a clear first goal.
- [ ] **Test:** `validateContent` still passes (shapes, references, acyclic recipe + tech graphs).

## M4 — Core-loop UI/UX

_BuildBar + InfoSidebar + inspect exist; research, village, and alerts are unrepresented._

- [ ] Research screen: tech tree view, active/queued tech, pack throughput, unlock preview.
- [ ] Village panel: current stage, satisfied/unmet demands, decline timer, buffer state.
- [ ] Alerts/notifications: stalled crafter, missing input, village declining.
- [ ] Build affordances: show recipe I/O + terrain requirement before placement; grey out
      un-researched buildings.
- [ ] Production stats / throughput readouts (extend `statsStore`).
- [ ] Pause / sim-speed controls surfaced in UI (scheduler already fixed-timestep).

## M5 — New-game & onboarding flow

- [ ] Main menu (new game / continue / load / quit).
- [ ] New-game setup (seed entry, starting scenario selection).
- [ ] Deterministic starting scene from the chosen seed (spawn scene + starting kit).
- [ ] Tutorial hints / guided first objectives (build first crafter → belt → lab → research).

## M6 — Feedback & polish

- [ ] Placement/removal, craft-tick, research-complete, and village-level SFX.
- [ ] Visual juice: build/remove animations, active-crafter indicators, belt item motion.
- [ ] Camera: smooth pan/zoom, edge scroll, follow, minimap (reads sim only — never mutates).
- [ ] Icon/art pass for the expanded content set (build on `iconTextures` / `buildIcons`).

## M7 — Balancing & playtest harness (gates the slice)

_Two instruments: [`apps/balance`](../../apps/balance/README.md) (`pnpm balance`) for the
**static** economy shape — raw costs, cost curve, machine ratios — and the headless runner
for the **dynamic** KPIs of a played-out seed. See [economy.md §8](./economy.md)._

- [ ] Headless scenario runner that reports economy KPIs (time-to-first-research,
      village growth curve, bottlenecks) for a seed set.
- [ ] Tune recipe rates / tech costs / village demand against those KPIs.
- [ ] Full playthrough of the slice; capture friction; iterate.
- [ ] **Gate:** verification gate green + a clean end-to-end play session → slice shippable.

---

# Post-slice (M8–M9)

## M8 — Modding platform maturation

- [ ] Author-facing mod API docs + a minimal example third-party mod in `mods/`.
- [ ] Mod hot-reload in dev (re-run `runModScripts` without full restart).
- [ ] Assert `ModApi` stability: contract tests + a changelog; additive-only discipline.
- [ ] Load-order / dependency + conflict diagnostics surfaced to the user.
- [ ] OS-level isolation for untrusted third-party mods (economy.md §6.6) behind the same API.

## M9 — Performance at scale

- [ ] Extend the perf guard beyond 10k entities toward the "thousands at 60fps" target
      with the new systems (research, expanded crafters) in the loop.
- [ ] Profile + kill any per-tick allocation introduced by M1–M3 (`pnpm bench`).
- [ ] Render batching / culling review for large factories.

---

## Open decisions to settle as we go

Carried from [economy.md §6](./economy.md):

- Continuous population vs. discrete village stages (refine only if stages feel steppy).
- Research queue semantics (single active tech vs. a queue) — decide during M1.
- ~~Save format ownership of mod-side stores — decide during M2 (M1 depends on the answer).~~
  **Settled (M2):** the engine snapshot carries an opaque per-mod `modState` blob it hashes but
  never interprets; each mod owns the (de)serialization under its own key. See the M2 checklist.
