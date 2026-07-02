# Economy & Progression — Core Mechanic Design

> Design spec for the central game loop. This is the contract the registry schema,
> the validation, the sim systems, and any third-party mod must agree with. It is
> intentionally **design-level**: it documents data shapes, rules, and invariants —
> not implementations, which would drift. Read alongside [`README.md`](../../README.md)
> (architecture) and [`CLAUDE.md`](../../CLAUDE.md) (working rules / invariants).

## 1. Overview — the core loop

The player builds **supply chains** that convert raw materials into increasingly
complex goods. Those goods feed **villages**. A village whose demand is met **grows**;
a village starved of supply **declines**. As a village grows it demands _more types_
of goods and _higher rates_ — and the new goods are deeper in the production chain, so
satisfying a mature village requires a sprawling, multi-stage factory.

Progression is gated by a **tech tree**: recipes and buildings are invisible/unbuildable
until the technology that unlocks them is researched.

## 2. The three graphs (keep them orthogonal)

The mechanic is three distinct graphs. Conflating them is the central design trap.

| Graph           | Encodes                              | Authored as             | Notes                                                                                |
| --------------- | ------------------------------------ | ----------------------- | ------------------------------------------------------------------------------------ |
| **Production**  | What is physically made from what    | `recipe` prototypes     | This _is_ the resource-dependency graph. Must be a DAG.                              |
| **Progression** | The order the player gains _access_  | `technology` prototypes | A gating overlay. References recipes/buildings; never redefines them. Must be a DAG. |
| **Demand**      | What villages need and how it scales | village `stages`        | The only runtime-dynamic graph.                                                      |

**Derived, never authored twice:**

- A resource's "complexity / tier" = its **depth in the production graph**. Do not
  hand-author a tier field; derive it. Single source of truth.
- "What is buildable right now" = **derived** from the set of researched technologies.
  One-way: sim → UI.

The production graph already encodes resource dependencies. The tech tree is a
_separate_ pacing layer — it usually follows production depth but is authored
independently so progression can be tuned without touching recipes.

## 3. Data schemas

All of this is **data in `mods/base`**, loaded through the prototype registry. The
engine stays game-agnostic (hard invariant in CLAUDE.md). Only the _rules_ (§4) are
sim code.

### 3.1 Items — `prototypes/items.json`

Items are pure leaves: `id`, `name`, `stackSize`, `color`, `icon`.
No tier field (derived from the recipe graph).

A resource is defined once, in one place, as an **icon + colour** pair — exactly like a
building. `color` is the resource's identity throughout the sim (it's what rides belts and
fills building slots); `icon` is a lucide glyph name (PascalCase, e.g. `"Wheat"`) drawn in
that colour wherever the UI or world refers to the resource — on the item as it rides a belt,
in a building's _Accepts_ / _Produces_ rows, and in the inspector. Every item must carry an
`icon`; the client resolves it through a colour→resource registry (`apps/game/src/resources.ts`)
so a bare colour alone renders the right glyph and name (an unknown colour falls back to a plain
swatch). Keep each item's `color` unique — it doubles as the lookup key.

### 3.2 Recipes — `prototypes/recipes.json` (new)

The production graph. Multi-input → multi-output, with a craft time and a category.
A recipe's inputs are **items, terrain, or both** — extraction is not a special kind
of building, just a recipe whose only input is terrain (see 3.3).

```json
{
  "id": "recipe.iron_plate",
  "type": "recipe",
  "category": "smelting",
  "ingredients": [{ "item": "item.iron_ore", "amount": 2 }],
  "results": [{ "item": "item.iron_plate", "amount": 1 }],
  "time": 60
}
```

An **extraction** recipe has no item ingredients and pulls from terrain instead:

```json
{
  "id": "recipe.grain",
  "type": "recipe",
  "category": "farming",
  "ingredients": [],
  "requiresTerrain": "terrain.fertile_soil",
  "results": [{ "item": "item.grain", "amount": 1 }],
  "time": 30
}
```

| Field             | Meaning                                                                   |
| ----------------- | ------------------------------------------------------------------------- |
| `category`        | Which buildings can run it (see 3.3).                                     |
| `ingredients`     | `{ item, amount }[]`. Empty for pure-extraction recipes.                  |
| `requiresTerrain` | Optional `terrain.*` id the building must sit on. May combine with items. |
| `results`         | `{ item, amount }[]`.                                                     |
| `time`            | Ticks at building `speed` 1. Effective time = `time / speed`.             |

### 3.3 Buildings — `prototypes/buildings.json`

There is **one** producing building type — the **`crafter`**. A crafter is a generic
machine: it advertises which `craftingCategories` it can run and nothing about _what_
it makes. The player assigns one matching recipe per crafter instance; the recipe (§3.2)
owns the ingredients, results, time, and any `requiresTerrain`.

```json
{
  "id": "building.furnace",
  "type": "crafter",
  "craftingCategories": ["smelting"],
  "speed": 1,
  "storage": 100
}
```

**There is no separate `producer` type.** Raw extraction is not a different kind of
building — it is a crafter assigned an _extraction recipe_ (no item ingredients, a
`requiresTerrain`; see §3.2). A farm is a crafter in the `farming` category placed on
fertile soil; a mine is a crafter in the `mining` category placed on a deposit. The
terrain constraint lives on the recipe, not the building, because a building could
legitimately consume terrain **and** items at once — so "pulls from terrain" can't be
the type boundary. This keeps the machine decoupled from what it makes (the whole point
of a recipe graph) and means a single furnace prototype can smelt iron _or_ copper.

Belts, splitter, input, output, village are unchanged.

### 3.4 Technologies — `prototypes/technologies.json` (new)

The progression overlay. Pure gate: it only references ids.

```json
{
  "id": "tech.basic_smelting",
  "type": "technology",
  "prerequisites": ["tech.mining"],
  "cost": [{ "item": "item.research_pack_1", "amount": 50 }],
  "unlocks": ["recipe.iron_plate", "recipe.copper_plate", "building.furnace"]
}
```

| Field           | Meaning                                                                |
| --------------- | ---------------------------------------------------------------------- |
| `prerequisites` | Other `tech.*` ids. Forms a DAG.                                       |
| `cost`          | Items consumed to research (research-pack model — see open decisions). |
| `unlocks`       | `recipe.*` and `building.*` ids that become buildable on completion.   |

### 3.5 Villages — staged demand

A village is a building with an escalating ladder of **stages**. Numbers live in
data; the transition _rule_ is sim code (§4).

```json
{
  "id": "building.village",
  "type": "village",
  "stages": [
    {
      "level": 1,
      "population": 50,
      "demands": [{ "item": "item.grain", "ratePerMin": 30 }],
      "growthThreshold": 0.9,
      "declineThreshold": 0.5
    },
    {
      "level": 2,
      "population": 150,
      "demands": [
        { "item": "item.grain", "ratePerMin": 60 },
        { "item": "item.wood", "ratePerMin": 20 },
        { "item": "item.bread", "ratePerMin": 15 }
      ],
      "growthThreshold": 0.9,
      "declineThreshold": 0.5
    }
  ]
}
```

| Field              | Meaning                                                |
| ------------------ | ------------------------------------------------------ |
| `population`       | Flavor / scoring at that level.                        |
| `demands`          | `{ item, ratePerMin }[]` consumed while at this level. |
| `growthThreshold`  | Satisfaction ≥ this (sustained) → advance a level.     |
| `declineThreshold` | Satisfaction < this (sustained) → drop a level.        |

### 3.6 Worked example chain

```
item.iron_ore  --recipe.iron_plate (smelting)-->  item.iron_plate
item.iron_plate --recipe.gear (assembly)------->  item.gear
item.grain     --recipe.bread (cooking)-------->  item.bread   (feeds village L2)
```

`tech.mining` → unlocks ore extraction; `tech.basic_smelting` → unlocks plates +
furnace; `tech.assembly` → unlocks gears + assembler. Village L1 wants grain only;
L2 adds wood + bread; later levels pull in gears, etc.

## 4. The growth / decline rule (math, implementation-agnostic)

Run on a fixed cadence (every tick or every N ticks — N is a tuning constant, must be
deterministic). For each village currently at stage `s`:

1. **Consume.** For each `demand` in `s`, attempt to remove `ratePerMin` (scaled to
   the cadence) from village storage. Track delivered vs requested per item.
2. **Satisfaction.** `satisfaction = min over demands of (delivered / requested)` —
   a village is only as happy as its worst-supplied need. (Weighted average is an
   option; min is harsher and reads more clearly to the player.)
3. **Hysteresis timer.** Accumulate time while `satisfaction ≥ growthThreshold`
   (toward growth) or while `< declineThreshold` (toward decline). The dead band
   between the thresholds prevents oscillation.
4. **Transition.** Timer exceeds the growth duration → `s := s + 1` (cap at last
   stage). Timer exceeds the decline duration → `s := s - 1` (floor at 1). Reset
   timers on transition.

All arithmetic is integer/fixed-point on the grid; any randomness uses the seeded RNG
only (§5).

## 5. Invariants (do not regress — see CLAUDE.md)

- **Determinism.** Same seed + tick count → identical `hashState`. Sim uses the seeded
  RNG only; no `Math.random` / `Date`. Every new system ships a determinism test.
- **Engine stays game-agnostic.** No village/recipe/tech concept in `packages/engine`.
  It all arrives as data/scripts via the prototype registry + mod loader. `mods/base`
  is mod zero, discovered by the same scan a third-party mod uses.
- **One-way sim → UI/render.** Buildable lists, satisfaction bars, etc. are reads.
  Render never mutates sim state.
- **Hot path.** Village consumption / crafting iterate query results by index with
  zero allocation per tick; integer math on the grid. Sanity-check with
  `pnpm headless <seed> <bigN>` and keep the perf guard green.
- **Validation.** The content must reject: dangling `item`/`recipe`/`building`
  references, cycles in the recipe graph, cycles in the tech prerequisite graph, and
  recipes whose `category` no crafter provides.

  **Where this lives (important, respects the engine-agnostic invariant):** the engine
  must not know what a `recipe` or `technology` is, so the _rules_ are split in two:
  - The **engine** ([`packages/engine/data/validate.ts`](../../packages/engine/data/validate.ts))
    provides **game-agnostic primitives** — `topologicalOrder` / `assertAcyclic`
    (cycle + missing-node detection over any content graph, generalised from the mod
    loader's dependency sort) and `validateReferences` (dangling / wrong-type reference
    checks). They take **selector functions**, so the engine never hardcodes a field
    name like `ingredients` or `prerequisites`. Covered by `engine/data` tests.
  - The **base game** supplies the recipe/technology Zod schemas and calls those
    primitives with the recipe/tech field selectors. Placement is an open decision
    (see §6.6).

## 6. Open decisions (settle before / during implementation)

1. **Demand scaling: discrete stages vs continuous population.** **Decided: discrete
   stages** (simple to balance, trivially deterministic). A float population driven by a
   supply/demand differential remains a possible later refinement if stages feel steppy.
2. **Recipe loops.** **Decided: no — the recipe graph is a strict DAG**; revisit only if
   a mechanic needs cyclic production (A→B→A).
3. **Research model.** **Decided: author + gate first, then a live loop (M1, now built).**
   Recipes and technologies are authored data and validated; the buildable set is _derived_
   from a `researchedSet`. The runtime loop is now live: a `workshop` (category `research`)
   crafts `item.research_pack` from early goods, a `lab` building stockpiles them, and a slow
   `researchSystem` drains packs into the single active tech (`set_active_research`) until its
   authored `cost` is met — then it is marked complete and unlocks its content. Root/no-prereq
   techs are seeded researched. See roadmap M1.
4. **Satisfaction aggregation.** **Decided: all current-stage demands must be met.**
   Stages list demands _cumulatively_ (each higher stage re-lists the lower needs), so a
   missing low-tier good starves every higher tier too. The village keeps an internal
   **buffer** and a **decline timer**: while any current-stage demand is unmet the timer
   accumulates; if satisfaction isn't restored before it elapses the village downgrades
   (equivalent to `min` semantics with hysteresis).
5. **Decline destructiveness.** **Decided: drop levels only, floored at level 1.** A
   starved village declines one stage at a time and is **never removed/abandoned**.
6. **Where game-specific schema + validation lives.** `mods/` is not a workspace
   package and the script sandbox is out of scope, so base-game logic currently lives
   **duplicated in the apps** (the headless app's
   [`gameLogic.ts`](../../apps/headless/gameLogic.ts) and the game app's copy, kept
   byte-for-byte). The recipe/technology Zod schemas and the call into
   the engine validators need a home. Options: (a) follow the existing precedent and
   put them beside `gameLogic.ts` (duplicated across both apps); (b) introduce a
   `packages/content` (or similar) workspace package both apps import — removes the
   duplication and is the natural pre-sandbox home; (c) wait for the script sandbox so
   it can live in `mods/base/scripts`. **Recommendation: (b)** — the duplication in (a)
   is exactly the kind of drift the determinism rules warn about, and a shared package
   is the smallest step that avoids it without depending on the out-of-scope sandbox.

   **Decided: (c) — live in `mods/base/scripts`.** The recipe/technology Zod schemas and
   the validator wiring live in the base mod, built on the engine primitives.

   **Sandbox status: ✅ done — Phases 2–4 are unblocked.** The in-process, deterministic
   script runner `runModScripts` in
   [`packages/engine/modloader/loader.ts`](../../packages/engine/modloader/loader.ts)
   executes each mod's `init(api)` in dependency order through the stable `ModApi`,
   collecting contributed systems. It is host-agnostic: the host supplies a
   `ScriptResolver` (how a script path becomes a module), mirroring `FileSource`. Both
   hosts are wired:
   - **Headless** ([`apps/headless/bootstrap.ts`](../../apps/headless/bootstrap.ts)) —
     resolver = dynamic `import()` under tsx.
   - **Electron** ([`apps/game/src/sim.ts`](../../apps/game/src/sim.ts)) — resolver =
     Vite `import.meta.glob` bundle lookup (`matchScriptKey`, covered by
     [`apps/game/tests/sim-script-resolver.test.ts`](../../apps/game/tests/sim-script-resolver.test.ts)).

   The base sim has been migrated into
   [`mods/base/scripts/sim.ts`](../../mods/base/scripts/sim.ts); the apps consume its
   read-only helpers through the thin `gameLogic.ts` re-export barrels (no app-side
   copies). True OS-level isolation for untrusted third-party mods stays a later concern —
   it can harden behind the same `ModApi` without breaking it.

## 7. Implementation phases

> Phases 1–4 below are complete. For the forward-looking, whole-game plan (macro/micro
> tasks toward a playable vertical slice and beyond), see [roadmap.md](./roadmap.md).

Each phase passes the full verification gate before the next
(`pnpm typecheck && pnpm lint && pnpm test && pnpm format:check`; plus the headless
determinism check when the sim changes).

1. **Engine validation primitives.** ✅ Done — game-agnostic `topologicalOrder` /
   `assertAcyclic` / `validateReferences` in
   [`packages/engine/data/validate.ts`](../../packages/engine/data/validate.ts), with
   `engine/data` tests. The base game wires its recipe/tech schemas on top of these
   (see §5 validation, and §6.6 for placement).

   > **The script sandbox is done (see §6.6), so Phases 2–4 are unblocked.** The
   > recipe/technology schemas + validation wiring live in `mods/base/scripts`.

2. **Data refactor.** ✅ Done — the four producing buildings in
   [`buildings.json`](../../mods/base/prototypes/buildings.json) are now the single
   `crafter` type (each with a `craftingCategories` + `speed`), and
   [`recipes.json`](../../mods/base/prototypes/recipes.json) holds their extraction
   recipes (no item ingredients, `requiresTerrain`). The sim runs a generic recipe-driven
   crafter (`runCrafters` in [`sim.ts`](../../mods/base/scripts/sim.ts)) over deposit/drain
   slots; the `place_crafter` command carries the recipe I/O.
3. **First chain + tech tree (author + gate only).** ✅ Done — the §3.6 chain
   (ore→plate→gear, grain→bread) and a 4-node tech tree are authored in
   [`recipes.json`](../../mods/base/prototypes/recipes.json) /
   [`technologies.json`](../../mods/base/prototypes/technologies.json). `validateContent`
   in [`content.ts`](../../mods/base/scripts/content.ts) (host-side, on the engine
   primitives) checks shapes, references, and the recipe/tech acyclic graphs; `buildableSet`
   derives the buildable set from a seeded `researchedSet` (seeded to _all_ techs until a
   research loop lands). No runtime research this pass (§6.3).

   > **Note:** validation lives host-side (`content.ts`, imported by both hosts like
   > `commands.ts`) rather than reached through a `ModApi.listPrototypes` addition, because
   > the engine validators are _value_ imports the sandboxed sim may not use — the host is
   > their correct home and keeps the stable `ModApi` untouched.

4. **Village system.** ✅ Done — the §4 rule (cumulative staged demand, internal buffer,
   decline timer, floored at level 1 — §6.4/§6.5) is the `villageSystem` in
   [`sim.ts`](../../mods/base/scripts/sim.ts), running on a slow cadence over a `VillageStore`.
   Determinism + grow/decline scenario tests read village stage/timers directly (building
   inventories are not in engine `hashState`); the perf guard stays green.

## 8. Balancing instrument — `apps/balance`

Before authoring a deep production graph (roadmap M3, and the KPI tuning in M7), the cost
curve has to be understood **statically** — you should be able to see what a top-tier good
truly costs without playing a full session. That is what
[`apps/balance`](../../apps/balance/README.md) is for. Run it with **`pnpm balance`**.

It is a **read-only, game-agnostic analyzer** — it never touches the sim and never mutates
prototypes. By default it reads the real `mods/base/prototypes/*.json`, so it doubles as the
authoring pipeline (the numbers you balance are the numbers you ship); point `--data <dir>`
at an experimental dir with the same JSON shape to design a tree before wiring it into the
game.

For every item, memoized over a topological order, it computes:

- **Raw-cost vector** — the bag of raw (leaf) resources embodied in one unit (unfolding the
  DAG down to terrain-extracted materials). The honest cost of a good.
- **Embodied labor** — total machine-seconds across the whole sub-tree per unit.
- **Composite** — a single scalar `Σ raw · weight` (per-raw weights configurable); the axis
  the cost curve is plotted on.
- **Tier** — longest path to a raw leaf.
- **Machine bill** — crafters per step to sustain a target units/sec, shared intermediates
  rolled up (the throughput-ratio answer, e.g. "2.67 iron mines per gear/sec").

The **cost curve by tier** flags any tier whose median composite, over the previous tier's,
leaves the intended growth band, plus per-tier outliers — the "is the long-run economy
escalating smoothly?" check. Knobs (tick rate, raw weights, growth band, spike threshold,
canonical-recipe overrides for multi-producer items) live in
[`config.ts`](../../apps/balance/config.ts); the cost math is covered by
`apps/balance/tests/model.test.ts` (a hand-checked chain + a real-prototype smoke test).

This complements the **headless runner** (§5, `pnpm headless`), which is the _dynamic_
instrument — it plays out a seeded run so M7 can read realized KPIs (time-to-first-research,
village growth). `balance` answers the static question ("is the graph well-shaped?");
`headless` answers the dynamic one ("does it play out that way?").
