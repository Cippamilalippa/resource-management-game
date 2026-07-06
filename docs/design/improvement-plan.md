# Improvement Plan — Toward Factorio / Factory Town depth

> A whole-game assessment and improvement backlog, organised by aspect. Written against the
> current state of the repo (post M1–M7 slice + M-QoL pass). Read alongside
> [roadmap.md](./roadmap.md) (what got built) and [economy.md](./economy.md) (the core-loop
> contract). Every item below respects the non-negotiables in [CLAUDE.md](../../CLAUDE.md):
> game concepts arrive as data/scripts in `mods/base`, the engine stays generic, determinism
> and the perf budget hold, UI never mutates sim state.
>
> Tags: **impact** ★–★★★ · **effort** S / M / L / XL.

## 0. Where the game stands — honest assessment

The foundations are genuinely strong: deterministic fixed-timestep sim, save/load with
hashing, mod-zero content pipeline, undo/redo, blueprints, drag-building, alerts, overlays,
sparklines, a 53-item / 52-recipe / 10-tech aerospace economy, and a balance analyzer. That
is more infrastructure than most hobby factory games ever get.

What separates it from Factorio / Factory Town today is not infrastructure — it's **stakes,
space, and texture**:

1. **Space is free.** The map is an empty void with six small deposit patches near spawn.
   Nothing is scarce, nothing is far, nothing is in the way. In Factorio the _map_ is the
   antagonist: finite patches force expansion, water/cliffs force routing, distance forces
   trains. Here a 40-tile factory footprint never has a reason to grow.
2. **Nothing runs out and nothing pushes back.** Deposits are infinite, machines run free
   (no power/fuel), and the only pressure is the village decline timer on one building.
   There's no reason to scale beyond satisfying four demand rows.
3. **One demand center, one axis of progression.** A single 4-stage Spaceport whose stage-1
   demand (rocket fuel) is already ~3 tiers deep. Factory Town's heart is many growing
   towns pulling different goods over real terrain.
4. **The moment-to-moment build vocabulary is thin.** Straight-only belt drags, no
   underground belts, no mergers-by-design, one machine tier, no power poles — the "solve a
   spatial puzzle elegantly" verbs that make Factorio's building _feel_ good.
5. **Presentation is programmer-art.** Vector rectangles + lucide glyphs read functionally
   but produce zero atmosphere; there is no music, no ambient world.

The plan below is ordered around fixing those five things.

---

## 1. Gameplay — core loop & stakes

- [ ] **G1. Finite deposits with richness.** ★★★ / M — Give each deposit tile an integer
      `richness` that extraction drains; exhausted tiles gray out; patch totals visible on
      hover and minimap. This single change creates the expansion loop (scout → outpost →
      logistics) that drives everything in Factorio. Data: per-terrain `richness` bands per
      scenario. Sim: one counter decrement in `runCrafters` (already integer, deterministic).
      Ship with a determinism + round-trip test; scenario knob for "infinite" to preserve
      the current chill mode.
- [ ] **G2. Power as a second network.** ★★★ / XL — Generators (burn coal / rocket fuel),
      power poles with coverage radius, machines stall without power (a new alert + status
      tint). Couples the whole factory to one shared resource, creates the classic
      bootstrap ("power needs coal needs miners need power") and a continuous sink for
      fuel. Engine stays generic: it's just another mod-zero store + system; coverage is
      integer Chebyshev like the cannon range. Phase it: (a) machines need _fuel_ delivered
      by belt (S, no new network), (b) electric network with poles (L).
- [ ] **G3. Multiple villages, distinct demand ladders.** ★★★ / M — The `VillageStore` is
      already multi-entry; the scene just spawns one. Scatter 2–4 settlements (mining camp,
      research colony, spaceport) at increasing distance, each with its own staged ladder
      starting _shallow_ (aluminum sheet, glass) and deepening. Distance + different needs
      = routing gameplay + a reason cannons exist. Mostly `scene.ts` + `buildings.json`.
- [x] **G4. Rebalance the demand ladder to start shallow.** ★★☆ / S — _Shipped: 6-stage
      cumulative ladder (glass → aluminum → sheet → microchip → rocket fuel/avionics →
      aircraft/rocket), starting kit rebased to glass, KPI-verified._ Stage 1 formerly
      demands `rocket_fuel` (tier ~4); the first hour is belt-spaghetti toward one deep
      good with the starting kit as a timer. Let stage 1 want tier-1/2 goods and climb.
      `pnpm balance` + the KPI harness exist precisely to tune this; use them.
- [ ] **G5. Win condition + score screen.** ★★☆ / S — There is no victory. Define one per
      scenario (e.g. "Spaceport reaches stage 4 / launch N rockets"), show a completion
      screen with stats (time, items produced, techs), and let the run continue after.
      Data: a `goal` field on scenarios; the objectives selector already computes similar.
- [ ] **G6. Treasury economy with real prices.** ★★☆ / M — Today any item banked in a depot
      credits 1 unit of its own colour, and build costs are only aluminum/glass. Price
      items by their **raw-cost composite** (the `apps/balance` model, computed at load
      into a colour→value table) into a single currency ("credits"), diversify build costs,
      and add ongoing sinks (per-building upkeep is a natural pressure knob). Makes "what
      should I sell?" a decision instead of "dump anything".
- [ ] **G7. Late-game repeatable research.** ★☆☆ / M — Infinite techs (e.g. "+10% crafter
      speed, cost ×2 each level") as a pack sink after `tech.orbital_launch`. Needs a
      `repeatable` flag + a speed modifier on the crafter system.

## 2. World & map

- [ ] **W1. Real procedural terrain.** ★★★ / L — Noise-driven biomes: water, rock/cliff
      (unbuildable), forest (harvestable wood?), plains. Deposits placed by distance bands —
      richer further out (pairs with G1). The engine needs nothing new (terrain grid +
      passability check at placement already exist); it's scene-gen + a `passable` flag on
      terrain prototypes + a deterministic noise impl on the seeded RNG. This is the single
      biggest "feels like a game world" upgrade.
- [ ] **W2. Terrain rendering pass.** ★★★ / M — Even before real art: per-biome ground
      fill, patch edges, subtle tile variation (hash-based), so the world isn't a flat
      void. Renderer-only (exempt from sim rules).
- [ ] **W3. Map view.** ★★☆ / M — Zoom out past a threshold into a chunky map mode
      (the minimap projection already exists — promote it to full-screen), with overlays:
      deposits, status/alerts, logistics. Factorio's M-key is core to managing scale.
- [ ] **W4. More scenarios as difficulty presets.** ★☆☆ / S — Island start, rich-but-far,
      "no starting treasury" hard mode. Pure `scenarios.json` once W1/G1 land.

## 3. Logistics depth (the build vocabulary)

- [ ] **L1. Underground belts.** ★★★ / M — The most-missed belt verb: cross belts without
      splitters, dive under buildings. Sim: a belt-tile pair linked over a gap (the
      neighbour table already supports arbitrary links); placement pairs entrance/exit
      with a max span; render draws the two caps.
- [x] **L2. L-shaped / path belt drags.** ★★☆ / M — _Shipped: `projectBeltPath`
      dominant-axis-first L routing (Shift flips), two-leg ghost + full-path count, one
      undoable gesture, corner re-aim covered end-to-end in tests._ Drags currently axis-project to a
      straight run. Let a drag turn one corner (dominant axis first), preview included —
      most belt runs are L-shaped, this halves gestures. `projectBelt` grows a variant;
      ghost + rasterizer share it (they already share the helper).
- [ ] **L3. Machine & belt tiers via upgrade tool.** ★★☆ / M — Mk2/Mk3 crafters (speed
      2/3, pure data) + an **upgrade planner** gesture: drag a marquee, everything inside
      swaps to its next tier for the cost delta, undoable. Belt redraw-to-upgrade already
      exists; generalize it into an explicit tool.
- [ ] **L4. Loader/merger affordances.** ★☆☆ / S–M — Side-loading onto an occupied belt
      already works via the back-up rule; add an explicit **merger** glyph (splitter
      variant with one output priority) and a splitter **priority/filter side**, both small
      extensions of the splitter round-robin.
- [ ] **L5. Trains / cargo airships (long-term).** ★★☆ / XL — Cannons cover point-to-point
      express; a scheduled multi-stop carrier (Factory Town's wagons/airships) is the
      late-game logistics layer. Defer until W1 makes distance real; design as mod-zero
      (a path + schedule store, integer waypoint motion like shells).
- [ ] **L6. Ghost/planning mode.** ★★☆ / L — The one deferred QoL item. With treasury
      pressure (G6) it becomes meaningful: place unaffordable ghosts, they build as funds
      allow. Needs the planned-flag sim state + persistence it was deferred for.

## 4. UI

- [ ] **U1. Art direction pass on the HUD.** ★★☆ / M — The panels are functional but
      generic glass boxes. Pick a visual identity (industrial/aerospace), consistent
      spacing/type scale, panel icons, hover states. Pure CSS/React, zero sim risk.
- [ ] **U2. Full production stats screen.** ★★☆ / M — Promote the sparklines to a modal
      (Factorio P-screen): per-item production/consumption over selectable windows,
      sortable, click-through to the item's recipes in the encyclopedia. Data already
      flows through `productionHistory`; it needs retention tiers + a real chart.
- [ ] **U3. Tech tree as a graph.** ★★☆ / M — The research panel is a list; render the
      10-node DAG as a proper tree with edges, unlock previews (icons of what each tech
      grants), and cost/prereq tooltips. Becomes essential as the tree grows (C1).
- [ ] **U4. Rate/ratio helper in the recipe picker.** ★★☆ / M — The `apps/balance` machine
      -bill math answers "how many smelters per assembler?" — surface it: recipe rows show
      per-minute rates; a selected crafter shows "feeds 0.6 of downstream demand" style
      hints. Read-only, reuse the balance model at load.
- [x] **U5. Better inspector.** ★☆☆ / S — _Shipped: recipe progress bar, slot fill bars,
      60s utilization %, belt occupant readout._ Selected crafter: recipe progress bar,
      input/output slot fill bars, utilization % over the last minute (sample in the HUD
      refresh). Selected belt: item + throughput. Much of this data exists in `inspect.ts`.
- [x] **U6. Alert history + severity.** ★☆☆ / S — _Shipped: capped timestamped history log + per-source mute filtering every alert-fed view._ Alerts currently aggregate live; add a
      dismissible log with timestamps and severity colours, and a "don't warn for this
      building" mute. App-side only.

## 5. UX & controls

- [x] **X1. Settings menu.** ★★☆ / M — _Shipped: volume, UI scale, autosave interval,
      edge-scroll, pause-on-blur (Q6), gear button + `O` key. Key rebinding deferred (handlers
      too scattered — needs a shared binding source first)._ There was none: volume slider, UI
      scale, autosave cadence, edge-scroll toggle+speed, key rebinding (persisted like the
      mute flag). Rebinding matters because the current map is dense (V/E/F/M/Q…).
- [x] **X2. Alt-mode overlay.** ★★☆ / S — _Shipped: Alt toggles a game-agnostic
      `setDetailOverlay` renderer layer — recipe-product icons on machines, warn ring on
      unconfigured crafters, filter chips on ports; persisted, default on._ One toggle that shows, on every machine, its
      recipe icon + port arrows + filter colours at a glance (the icon overlay
      infrastructure already exists — this is "always-on for all, bigger"). Factorio's
      single most-used key.
- [ ] **X3. Blueprint UX round-out.** ★☆☆ / M — Rotate a blueprint before paste (R),
      mirror, and blueprint books/tags in the library; import/export as a string for
      sharing. The capture/paste path exists; rotation needs port-facing math.
- [ ] **X4. Smarter placement affordances.** ★☆☆ / S — Auto-rotate a port toward the only
      adjacent building; belt drag from an output port pre-arms the right facing; show
      the cannon's range ring while placing a silo. Small `placement.ts` wins.
- [ ] **X5. Onboarding: a real first-15-minutes.** ★★☆ / M — Expand the objectives
      checklist into a light tutorial scenario: staged goals with arrows/highlights
      pointing at the build bar / a deposit / the lab, each unlocking the next hint.
      Data-driven goals (the `gameObjectives` selector pattern scales to this).

## 6. QoL

- [ ] **Q1. Pin favourite tools row.** S — The build bar has search; add a pinned row
      (was explicitly left as an extension).
- [ ] **Q2. Copy/paste machine settings.** S — Shift+Q copies recipe already; extend to
      port filters (noted as a later extension in the roadmap) and cannon targets.
- [x] **Q3. Save slot thumbnails + play-time.** S — _Shipped: canvas-captured JPEG + h:mm
      play time in every slot, additive save meta (old saves fine)._ Capture a downscaled canvas screenshot
      into the save envelope meta; show in `SaveMenu`.
- [x] **Q4. "Where is it used / made?"** S — _Shipped: clickable resource labels
      (treasury/inspector/recipe rows) open the encyclopedia split into produces/consumes._ Click any item anywhere (treasury bar,
      inspector, alerts) → encyclopedia filtered to recipes producing/consuming it.
- [x] **Q5. Undo depth indicator + history panel.** S — _Shipped: undo/redo toast with
      remaining depth + hoverable recent-steps panel._ The stack exists; show it.
- [x] **Q6. Pause-on-menu-blur / focus safety.** S — _Shipped with X1 (settings toggle;
      only lifts a pause it set itself)._ Pause when the window loses focus
      (optional, X1 setting).

## 7. Presentation — art, audio, juice

- [ ] **P1. Sprite/texture atlas pass.** ★★★ / L — Replace flat vector fills with a real
      tile atlas: belts with animated tread, machine sprites with idle/working frames,
      terrain tiles (W2). The renderer already maps `sprite` ids and icon textures; extend
      it to atlas frames while keeping the engine game-agnostic (mods supply the atlas —
      an additive `ModApi`/host asset channel). Biggest perceived-quality jump available.
- [ ] **P2. Music + ambient audio.** ★★☆ / M — A few loopable tracks + world-positional
      machine hum near the camera (Web Audio, wall-clock, sim-independent like `sfx.ts`).
- [ ] **P3. More juice.** ★☆☆ / S–M — Item pop on port pickup/drop, cannon muzzle flash +
      shell arc shadow, village level-up celebration, research-complete banner. All
      renderer/overlay-side.
- [ ] **P4. Colorblind safety.** ★☆☆ / S — Resource identity is _colour-keyed_ by design;
      icons mostly cover it, but audit every colour-only surface (port filters, treasury
      swatches, minimap) and add glyph/pattern fallbacks.

## 8. Content & progression breadth

- [ ] **C1. Grow the tech tree with the new systems.** M — Power (G2), logistics tiers
      (L1/L3), cannons, depots and villages-features should all be _researched_, not
      given: 10 techs → ~25 with real branches. Pure data + validation already in place.
- [ ] **C2. Byproducts & multi-output balancing.** M — Distillation-style recipes with a
      waste/byproduct to reuse or sink (the recipe schema already supports multi-output;
      the gameplay of "deal with the byproduct" is untapped).
- [ ] **C3. A second themed mod as proof.** M — A small `mods/agri` (Factory Town-flavored
      food chain) proves the mod pipeline end-to-end and doubles as M8's example mod.

## 9. Tech & performance (guardrails while all this lands)

- [ ] **T1. Extend the perf guard** to cover power coverage, depletion checks and
      multi-village scans at 10k+ entities; keep `pnpm bench` runs in PRs that touch the
      hot path.
- [ ] **T2. Renderer culling/batching review** before P1 (sprite counts will jump).
- [ ] **T3. Save migration seam** (`SNAPSHOT_VERSION` upgrade path) — flagged `[~]` in M2
      and becomes urgent the moment G1/G2 add persisted stores.
- [ ] **T4. KPI-driven balance loop as CI habit** — run `pnpm kpi play` seed sweeps after
      any economy change; wire a "KPI drift" report into the verification routine.

---

## 10. Suggested sequencing

Three arcs, each shippable and play-testable on its own:

**Arc 1 — "The world pushes back" (stakes):**
G4 (shallow ladder, S) → G1 (finite deposits, M) → W1+W2 (real terrain + render, L+M) →
G3 (multiple villages, M) → G5 (win condition, S).
_Outcome: expansion pressure, spatial decisions, a beginning-middle-end. This is the arc
that changes what the game **is**; everything here is mostly `mods/base` data + scene-gen._

**Arc 2 — "Building feels great" (verbs & QoL):**
L2 (corner drags, M) → L1 (underground belts, M) → X2 (alt-mode, S) → L3 (tiers + upgrade
planner, M) → U4 (ratio helper, M) → X1 (settings, M) → Q1–Q4.
_Outcome: the moment-to-moment loop reaches Factorio-grade ergonomics._

**Arc 3 — "It looks and sounds like a game" (texture & depth):**
P1 (sprite pass, L) → P2 (music/ambience, M) → G2 (power network, XL) → U2/U3 (stats +
tech-tree screens, M+M) → C1 (tech breadth, M) → G6 (real economy, M).
_Outcome: atmosphere + the second network layer that gives the late game its depth._

Long-term shelf (revisit after the arcs): L5 trains/airships, L6 ghost mode, G7 infinite
research, fluids/pipes, C3 second mod, mod-platform maturation (M8), enemies/threats
(a deliberate open question — Factory Town thrives without them).

Every sim-touching item above ships with the standard gate: determinism test, round-trip
test if persisted, perf guard green, `pnpm headless 99 750` hash stable.
