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

Unchanged in shape. Items are pure leaves: `id`, `name`, `stackSize`, `color`.
No tier field (derived from the recipe graph).

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

1. **Demand scaling: discrete stages vs continuous population.** This spec uses
   discrete stages (simple to balance, trivially deterministic). Alternative: a float
   population driven by a supply/demand differential, with continuously scaling needs.
   **Recommendation: ship stages first**, interpolate later if it feels too steppy.
2. **Recipe loops.** Are cyclic production chains allowed (A→B→A)? Default
   **no — recipe graph is a strict DAG**; revisit only if a mechanic needs it.
3. **Research model.** Are research packs craftable items consumed from a building
   (Factorio-style, assumed here via `cost`), or an abstract accumulating currency?
4. **Satisfaction aggregation.** `min` (assumed) vs weighted average across demands.
5. **Decline destructiveness.** Does a village drop levels only, or can it be
   abandoned/removed at level 0?
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

   **Decided: (c) — wait for the script sandbox.** The recipe/technology Zod schemas
   and the validator wiring will live in `mods/base/scripts`, built on the engine
   primitives. Phases 2–4 below are therefore **blocked until the sandbox lands**.

   **Sandbox status (in progress):** the in-process, deterministic script runner now
   exists — `runModScripts` in
   [`packages/engine/modloader/loader.ts`](../../packages/engine/modloader/loader.ts)
   executes each mod's `init(api)` in dependency order through the stable `ModApi`,
   collecting contributed systems. It is host-agnostic: the host supplies a
   `ScriptResolver` (how a script path becomes a module), mirroring `FileSource`. The
   **headless** app is wired ([`apps/headless/bootstrap.ts`](../../apps/headless/bootstrap.ts),
   resolver = dynamic `import()` under tsx) and the base mod's script runs for real
   with the state hash unchanged. _Remaining before Phases 2–4 unblock:_ (i) an
   **Electron** resolver (renderer/main bundling — the build-system fork) and (ii)
   migrating the app-duplicated `gameLogic.ts` into `mods/base/scripts` (large,
   determinism-sensitive). True OS-level isolation for untrusted third-party mods stays
   a later concern — it can harden behind the same `ModApi` without breaking it.

## 7. Implementation phases

Each phase passes the full verification gate before the next
(`pnpm typecheck && pnpm lint && pnpm test && pnpm format:check`; plus the headless
determinism check when the sim changes).

1. **Engine validation primitives.** ✅ Done — game-agnostic `topologicalOrder` /
   `assertAcyclic` / `validateReferences` in
   [`packages/engine/data/validate.ts`](../../packages/engine/data/validate.ts), with
   `engine/data` tests. The base game wires its recipe/tech schemas on top of these
   (see §5 validation, and §6.6 for placement).

   > **Phases 2–4 are blocked on the script sandbox** (see §6.6). The recipe/technology
   > schemas + validation wiring will live in `mods/base/scripts` once it lands.

2. **Data refactor.** Converge the producing buildings in
   [`buildings.json`](../../mods/base/prototypes/buildings.json) onto the single
   `crafter` type (the current `producer` farm/woodcutter/mine become crafters with a
   `craftingCategories`); add `prototypes/recipes.json`, moving each old building's
   fixed output into an extraction recipe (no item ingredients, `requiresTerrain`).
3. **First chain + tech tree.** Author the §3.6 chain and a 2–3 node tech tree;
   validate end to end.
4. **Village system.** Implement the §4 rule as a sim system; add a determinism test
   (same seed + ticks → identical `hashState`) and keep the perf guard green.
