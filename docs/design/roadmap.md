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

_An aerospace progression is now authored: 53 items / 52 recipes across 7 tiers (raw ores →
refining/smelting → intermediates → avionics/propulsion → jet_engine / satellite / aircraft /
rocket), gated by a 10-node tech tree, with the balance tool ([`pnpm balance`](../../apps/balance/README.md))
tracking the cost curve._

- [x] Expand the production graph: 2–3 more tiers of intermediate + final goods
      ([recipes.json](../../mods/base/prototypes/recipes.json)), staying a strict DAG. _(52 recipes,
      strict DAG — the balance tool unfolds every good to raw and reports a smooth curve bar the
      tier-5/6 spikes left for M7 tuning.)_
- [x] Grow the tech tree to gate those tiers meaningfully
      ([technologies.json](../../mods/base/prototypes/technologies.json)). _(10 techs, root→orbital_launch.)_
- [x] Wire the village demand ladder to the new goods so higher stages pull higher tiers
      ([buildings.json](../../mods/base/prototypes/buildings.json) `demands`).
- [x] Author starting-scenario resources/terrain so the early game has a clear first goal
      ([scene.ts](../../mods/base/scripts/scene.ts): village + orchard + six gated deposit patches).
- [x] **Test:** `validateContent` still passes (shapes, references, acyclic recipe + tech graphs).
      _([apps/headless/tests/content.test.ts](../../apps/headless/tests/content.test.ts) covers
      missing refs, orphan categories, tech + recipe-graph cycles, village-demand validation,
      and `buildableSet` tech-gating.)_

## M4 — Core-loop UI/UX

_The read-only HUD selectors live in [hud.ts](../../mods/base/scripts/hud.ts) (surfaced through the
`gameLogic` barrels, covered by [hud.test.ts](../../apps/headless/tests/hud.test.ts)); the boot loop
assembles a `HudState` each throttled refresh and pushes it to the app-side `hudStore`, which the
React panels read. Research is now player-driven — the host-side auto-select stopgap from M1 is gone._

- [x] Research screen: tech tree view (available / locked / researched), active tech + per-pack
      progress, lab count, cost preview, click-to-select. See [HudPanels.tsx](../../apps/game/src/HudPanels.tsx).
- [x] Village panel: level/stage, per-demand satisfied/unmet bars vs. buffer, population, and a
      growth/decline trend bar ([HudPanels.tsx](../../apps/game/src/HudPanels.tsx) `VillagePanel`).
- [x] Alerts/notifications: starved crafter (missing input), backed-up output, declining village —
      aggregated with counts ([Alerts.tsx](../../apps/game/src/Alerts.tsx)).
- [x] Build affordances: tech-gated, un-researched tools stay on the bar greyed/locked and
      unselectable ([BuildBar.tsx](../../apps/game/src/BuildBar.tsx)).
- [x] **Factorio-style machines**: the build bar shows one tool per crafter _building_ (12), not
      one per recipe (52). A machine places empty and its recipe is chosen in the sidebar recipe
      picker; extraction machines (mines/derricks) auto-adopt the recipe matching the terrain they
      sit on. The chosen recipe is a new `set_recipe` command + a persisted `recipe` id on the
      building. See [machines.ts](../../apps/game/src/machines.ts),
      [RecipePanel.tsx](../../apps/game/src/RecipePanel.tsx), and
      [recipe.test.ts](../../apps/headless/tests/recipe.test.ts).
- [x] Production stats / throughput readouts: installed per-resource make/use rates
      ([HudPanels.tsx](../../apps/game/src/HudPanels.tsx) `ProductionPanel`, `productionFlows`).
- [x] Pause / sim-speed controls surfaced in UI: pause (Space) + 0.5/1/2/4× speed (`[` / `]`),
      scaling the frame delta into the fixed-timestep scheduler so the sim stays deterministic
      ([SimControls.tsx](../../apps/game/src/SimControls.tsx), [simControlStore.ts](../../apps/game/src/simControlStore.ts)).

## M5 — New-game & onboarding flow

_The app now boots into a menu shell rather than straight into a game: an `appStore` phase
(`menu` / `setup` / `playing`) gates the overlay, the frame loop only advances the sim while
`playing`, and starting/loading a session flips it. The starting scene is now **procedural** —
seed + scenario drive a reproducible layout via a new additive `ModApi.random`/`randomInt` (the
world's seeded RNG), so mods keep their no-`Math.random` guarantee._

- [x] Main menu ([MainMenu.tsx](../../apps/game/src/MainMenu.tsx)): new game / continue (loads the
      most recent slot) / load (opens [SaveMenu.tsx](../../apps/game/src/SaveMenu.tsx) in a load-only
      mode) / quit (a new `factory:quit` IPC). Continue/Load gate on save availability.
- [x] New-game setup ([NewGameSetup.tsx](../../apps/game/src/NewGameSetup.tsx)): seed entry (+ a
      randomize button) and starting-scenario selection, driven from a data-driven scenario registry
      ([scenarios.json](../../mods/base/prototypes/scenarios.json), validated by `validateContent`;
      the picker reads `scenarioList`).
- [x] Deterministic starting scene from the chosen seed + scenario
      ([scene.ts](../../mods/base/scripts/scene.ts)): deposits scattered within the scenario's
      size/spread bands via the seeded RNG (kept clear of the village/orchard), plus an optional
      per-scenario starting kit granted to the village. Threaded through `SimOrigin`/`createSim`
      (renderer) and `BootstrapOptions.scenario` (headless), both via the base mod's `newGame(config)`
      closure. Two scenarios authored (`scenario.abundant`, `scenario.sparse`).
- [x] Guided first objectives ([Objectives.tsx](../../apps/game/src/Objectives.tsx)): an ordered,
      self-hiding checklist (place a machine → belt → lab → choose research) derived read-only from
      `GameState` (`gameObjectives` in [hud.ts](../../mods/base/scripts/hud.ts)) — stateless, so it
      always reflects the live world and needs no persistence.
- [x] **Test:** procedural-scene determinism (same seed + scenario → identical snapshot hash, before
      and after ticks; varies with seed and scenario) in
      [scene.test.ts](../../apps/headless/tests/scene.test.ts); scenario validation +
      `scenarioList` in [content.test.ts](../../apps/headless/tests/content.test.ts); `gameObjectives`
      in [hud.test.ts](../../apps/headless/tests/hud.test.ts); `ModApi.random`/`randomInt` contract in
      [modApi.test.ts](../../packages/engine/tests/modApi.test.ts).

## M6 — Feedback & polish

- [ ] Placement/removal, craft-tick, research-complete, and village-level SFX. _(Postponed.)_
- [x] Visual juice: build/remove animations, active-crafter indicators, belt item motion.
      _Entities pop in (ease scale+fade) on placement and dissolve out on removal, driven by a
      wall-clock frame delta in the read-only [renderer.ts](../../packages/engine/render/renderer.ts)
      (sim-independent, so determinism is untouched). Active crafters pulse a halo: the base
      crafter flags "working" per entity via a new additive `ModApi.setActive`
      ([modApi.ts](../../packages/engine/scripting/modApi.ts)) that writes a **transient**
      `RenderHints.active` channel ([components.ts](../../packages/engine/core/components.ts)) —
      never serialized or hashed, so it can't perturb saves (guarded by
      [persistence.test.ts](../../packages/engine/tests/persistence.test.ts) and
      [modApi.test.ts](../../packages/engine/tests/modApi.test.ts)). Belt item motion already
      glides one tile per move-cycle via `beltMoveAlpha`._
- [x] Camera: smooth pan/zoom, edge scroll, follow, minimap (reads sim only — never mutates).
      _Smooth eased zoom (target-tracked, focal-stable), screen-edge panning, and a follow/focus
      glide (F re-centers on the cursor tile) landed in [camera.ts](../../packages/engine/render/camera.ts),
      driven off the render ticker in [renderer.ts](../../packages/engine/render/renderer.ts) and gated
      by `renderer.edgeScroll` while a modal/menu is up. Covered by
      [camera.test.ts](../../packages/engine/tests/camera.test.ts) (the Camera stays pure — its only
      runtime dep is `@factory/shared`, so the pan/zoom/follow math is unit-tested without a GPU).
      The **minimap** is a screen-space corner overview drawn each frame in the renderer from live
      entity positions (a direct stage child, so the camera transform never moves it): every non-item
      entity is plotted in its own colour with a live "you are here" viewport rectangle, and a
      click/drag glides the camera there via the same eased follow as F. The projection math lives in a
      pure [minimap.ts](../../packages/engine/render/minimap.ts) (aspect-preserving fit + forward/inverse
      projection) alongside a pure `Camera.worldViewBounds()`, both unit-tested without a GPU
      ([minimap.test.ts](../../packages/engine/tests/minimap.test.ts),
      [camera.test.ts](../../packages/engine/tests/camera.test.ts)); the app gates `renderer.minimap`
      with the same phase/menu rule as edge-scroll._
- [ ] Icon/art pass for the expanded content set (build on `iconTextures` / `buildIcons`).

## M7 — Balancing & playtest harness (gates the slice)

_Two instruments: [`apps/balance`](../../apps/balance/README.md) (`pnpm balance`) for the
**static** economy shape — raw costs, cost curve, machine ratios — and the headless runner
for the **dynamic** KPIs of a played-out seed. See [economy.md §8](./economy.md)._

- [x] Headless scenario runner that reports economy KPIs (time-to-first-research,
      village growth curve, bottlenecks) for a seed set. _(The sampling/report harness —
      [`pnpm kpi`](../../apps/headless/kpi-run.ts) boots a seed, runs it while sampling the
      read-only HUD selectors at a fixed cadence, and folds the curve into a `KpiReport`
      (time-to-first-research, peak/final village stage, recurring bottlenecks). Pure read-only
      observer: chunked sampling is byte-identical to one long run — covered by
      [kpi.test.ts](../../apps/headless/tests/kpi.test.ts). The **seed-set sweep**:
      `pnpm kpi <s0,s1,…>` runs `runKpiSweep` across the seeds and folds the per-seed reports into a
      `KpiSweepReport` — cross-seed min/max/mean of each KPI plus the bottlenecks shared across seeds,
      ranked by how many seeds hit them. The **authored played-out scenario** is now in too:
      [playbook.ts](../../apps/headless/playbook.ts) (`playFirstResearch`) reads the freshly-booted
      scene and hand-routes a real belt-fed factory — a miner on each of the bauxite / coal / silica
      deposits feeding a refine→smelt→science chain into a lab, with the first research
      (`tech.oil_refining`) selected — through the same command bridge the build UI uses (it never
      mutates sim state, so the run stays deterministic). Internal links are straight hand-laid runs;
      the three raw feeders are wired by a small BFS grid router around the deposit scatter. Drive it
      with `pnpm kpi play [seed|s0,s1,…]`, or as the sweep's per-seed `drive` hook, so the KPIs reflect
      a played factory (research completes, raw flows) instead of the do-nothing baseline. Covered by
      [playbook.test.ts](../../apps/headless/tests/playbook.test.ts): determinism (same seed → same
      hash) + liveness (the chain completes the first tech). Routing succeeds on the large majority of
      layouts; a feeder it can't wire is skipped, leaving the run deterministic regardless.)_
- [ ] Tune recipe rates / tech costs / village demand against those KPIs.
- [ ] Full playthrough of the slice; capture friction; iterate.
- [ ] **Gate:** verification gate green + a clean end-to-end play session → slice shippable.

---

# Milestone: Quality-of-life (M-QoL)

_The core loop is playable (M1–M5) and juiced (M6). This milestone is about the **feel of the
moment-to-moment build/manage loop** — making construction effortless and the factory legible.
Weighted toward **build ergonomics** (QoL-1) first, since undo + drag-editing change how the game
feels the most; feedback/onboarding/polish follow._

> Same invariants as everything above — **UI never mutates sim state** (gestures only enqueue
> commands the sim applies next tick), **determinism** (no `Date.now`/`Math.random` in
> `mods/**/scripts`), **render is a read-only view**. New commands ship a determinism test; any
> persisted-state change ships a serialize→deserialize round-trip test. Read-only feedback
> (overlays, charts, SFX, tooltips) lives in `apps/game/src` or `render/` and must not touch the sim.

## QoL-1 — Build ergonomics (priority)

- [x] **Undo / redo of build actions (v1: placements).** New
      [historyStore.ts](../../apps/game/src/historyStore.ts) holds a bounded (100) stack of
      inverse/replay command pairs. Every placement gesture in
      [placement.ts](../../apps/game/src/placement.ts) — single building/port/splitter/crafter, a belt
      run, and a whole blueprint paste (one grouped step) — records its inverse (`remove` per filled
      tile, refunding the original charge) and its replay (the original `place_*` command). Ctrl+Z
      undoes / Ctrl+Shift+Z (or Ctrl+Y) redoes, dispatched through the new generic
      `dispatchCommand` bridge ([commands.ts](../../mods/base/scripts/commands.ts)) as ordinary
      queued commands — so the sim only ever sees regular place/remove ops and **determinism is
      untouched** (verified: `pnpm headless 99 750` matches across runs; no engine/sim change).
      History resets on each session swap (new-game/load). Covered by
      [history.test.ts](../../apps/game/tests/history.test.ts) (LIFO undo, redo-branch invalidation,
      refund symmetry, labels).
- [x] **Undo / redo of deletions + recipe edits.** Delete (click or marquee sweep) is now undoable:
      the gesture captures the affected region as a blueprint _before_ removing (read-only, via the
      existing `captureBlueprint`), then removes exactly those captured objects — so undo re-places
      them (charging the same cost) and redo removes them (refunding). No sim echo was needed after
      all: the reconstruction is client-side, and `removeTile` never clears the inspector registry, so
      re-placed objects keep their names. Recipe changes from the sidebar picker are also undoable —
      the controller captures the crafter's current recipe as the inverse `set_recipe`. Paste and
      delete-undo share one `placementToStep` bridge so a re-placed object matches a pasted one.
      Covered by a delete→undo in-place round-trip in
      [blueprint.test.ts](../../apps/game/tests/blueprint.test.ts); determinism unchanged
      (client-side command replay, no engine/sim change). _(Port filter/rotate edit-undo still to
      come — the empty→first-recipe assignment has no clean inverse command and is intentionally not
      recorded.)_
- [x] **Rectangular drag-delete.** With the delete tool armed, a drag draws a red marquee and
      sweep-removes every removable tile inside it on release (a single tile still deletes on click);
      each removed object refunds via the shared `removeTile` path. See
      [placement.ts](../../apps/game/src/placement.ts) (`onDragMove`/`onDragEnd` delete branches).
- [x] **Drag / line-stamp for machines & ports.** A machine or port tool now stamps a flush row along
      an axis-projected drag (`lineTiles`, stepping by footprint for machines, 1 for ports), previewed
      as a line ghost, recorded as one undoable gesture; each stamped machine resolves its own
      recipe per tile (terrain for extraction, else the pipette recipe). [placement.ts](../../apps/game/src/placement.ts).
- [x] **Config pipette (Shift+Q).** Q picks the tool under the cursor; Shift+Q also copies that
      crafter's recipe, so subsequent machine placements of the same type adopt it — lay down a row of
      identically-configured smelters in one pass. Threaded through an additive copy-config flag on the
      render pick callback. See [placement.ts](../../apps/game/src/placement.ts). _(Port-filter copy is
      left as a later extension.)_
- [~] **Planning / ghost mode (deferred construction).** _Deferred._ This is the one QoL item that
  needs invasive change to the central placement path (or an additive planned-flag sim state plus
  persistence), so landing it in the same pass as the rest carries real regression risk against the
  build flow and the determinism/persistence invariants — it wants its own focused, play-tested
  change. The existing **blueprint copy-paste** already provides deferred multi-placement, so the
  core "lay it out, then build" need is partly served today. Design unchanged from below.
- [x] **Inline cost + affordability on the ghost.** The build ghost tints red when the treasury
      can't afford the cost (via `canAfford`, alongside the terrain/link reject tint), and the build
      detail panel shows each tool's cost as resource swatches + amounts.
      [placement.ts](../../apps/game/src/placement.ts), [BuildBar.tsx](../../apps/game/src/BuildBar.tsx).

## QoL-2 — Information & feedback

- [x] **Clickable alerts → camera jump.** Each [Alerts.tsx](../../apps/game/src/Alerts.tsx) row is a
      button that glides the camera to the alert's source tile via a new read-only `renderer.focusTile`
      (the F-key/minimap eased follow), wired through a tiny `focusStore` bridge.
- [x] **Heat / status overlays.** A "Status" toggle (button + `V`) tints every trouble-spot tile on
      the map — starved crafters, backed-up outputs, declining villages — drawn in a new read-only
      `renderer.setStatusOverlay` layer from the same HUD alert selector the stack uses.
      [StatusOverlay.tsx](../../apps/game/src/StatusOverlay.tsx), [overlayStore.ts](../../apps/game/src/overlayStore.ts).
- [x] **Production sparklines over time.** `ProductionPanel` now charts each resource's make-rate
      trend from a rolling [productionHistory.ts](../../apps/game/src/productionHistory.ts) sampled on
      the throttled HUD refresh (wall-clock, never the sim). [HudPanels.tsx](../../apps/game/src/HudPanels.tsx).
- [x] **Searchable build bar + recipe lookup.** [BuildBar.tsx](../../apps/game/src/BuildBar.tsx) has a
      search box that filters tools by name across groups (number keys pick results); the
      **encyclopedia** below is the recipe lookup.

## QoL-3 — Onboarding & polish

- [x] **In-game recipe/tech encyclopedia.** A searchable "Recipes" modal (button + `E`) lists every
      recipe — machine, ingredients → products, craft time — built read-only from the loaded
      machine/recipe catalogue. [Encyclopedia.tsx](../../apps/game/src/Encyclopedia.tsx),
      [encyclopedia.ts](../../apps/game/src/encyclopedia.ts).
- [x] **SFX** — procedural Web Audio cues (no asset files) for place / remove / research-complete /
      village-level, muteable with `M` (persisted). Wall-clock, sim-independent.
      [sfx.ts](../../apps/game/src/sfx.ts). _(Per-craft-tick SFX intentionally omitted — too noisy.)_
- [x] **Keybind polish** — mouse-wheel rotates an armed port's facing (falls through to zoom
      otherwise) via an additive `renderer.onWheel`; `M` mutes sound. [HelpOverlay.tsx](../../apps/game/src/HelpOverlay.tsx)
      updated. _(Configurable rebinds + a pinned favourites row left as a later extension.)_
- [x] **Treasury/bank display.** An always-visible top strip shows the banked build-cost resources
      and how much of each is held, so affordability is legible (the ghost already tints red when a
      placement is out of reach — this shows the actual balance). `treasuryBalances` is plumbed into
      `HudState`; strip in [TreasuryBar.tsx](../../apps/game/src/TreasuryBar.tsx). Read-only.
- [x] **Drag length readout.** Dragging a belt, or line-stamping machines/ports, now draws a live
      "×N" count at the drag's end tile (an additive `label` on the line ghost + a reused Pixi text in
      the renderer), so the run length reads before release. [placement.ts](../../apps/game/src/placement.ts).

**Shipped this pass:** everything above except planning/ghost mode (dropped at the user's request) and
port-filter edit-undo. Deletion + recipe-edit undo landed. New logic covered by
[history.test.ts](../../apps/game/tests/history.test.ts), [qol.test.ts](../../apps/game/tests/qol.test.ts)
and a delete→undo round-trip in [blueprint.test.ts](../../apps/game/tests/blueprint.test.ts); full gate
green + determinism unchanged (`pnpm headless 99 750` → `f37ae68a` across runs).

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
