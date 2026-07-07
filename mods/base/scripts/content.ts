/**
 * Base-game CONTENT VALIDATION and buildable-set derivation.
 *
 * Like `commands.ts`, this is HOST-side code (the headless bootstrap and the Electron
 * renderer's `createSim` call it), NOT the sandboxed per-tick sim — so it may value-import the
 * engine's game-agnostic data primitives directly. It lives here in `mods/base/scripts` so the
 * recipe/technology rules are a single source of truth shared by both hosts, exactly like the
 * command bridge.
 *
 * Two jobs:
 *   1. {@link validateContent} — after the mod loader has registered all prototypes, assert the
 *      recipe/technology/crafter/village content is well-formed: correct field shapes, no
 *      dangling references, no cycles in the recipe production graph or the tech-prerequisite
 *      graph, and every recipe `category` provided by some crafter. Bad content throws loud.
 *   2. {@link buildableSet} — derive which recipes/buildings are buildable from the set of
 *      researched technologies (a `technology.unlocks` id is gated until a tech that unlocks it
 *      is researched; an id no tech gates is always buildable). One-way sim/content → UI.
 */
import {
  PrototypeError,
  assertAcyclic,
  validateReferences,
  type Prototype,
  type PrototypeRegistry,
} from '@factory/engine/data'
import { computeItemPrices, type PriceRecipe } from '@factory/shared'

// --- shape helpers ----------------------------------------------------------

function fail(msg: string): never {
  throw new PrototypeError(msg)
}

/** Read a `{ item, amount }[]` flow list off a prototype field, validating its shape. */
function flows(proto: Prototype, field: string): { item: string; amount: number }[] {
  const raw = proto[field]
  if (raw === undefined) return []
  if (!Array.isArray(raw)) fail(`${proto.id}: "${field}" must be an array`)
  return raw.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null)
      fail(`${proto.id}: ${field}[${i}] must be an object`)
    const e = entry as Record<string, unknown>
    if (typeof e.item !== 'string') fail(`${proto.id}: ${field}[${i}].item must be a string`)
    if (typeof e.amount !== 'number' || !Number.isInteger(e.amount) || e.amount <= 0) {
      fail(`${proto.id}: ${field}[${i}].amount must be a positive integer`)
    }
    return { item: e.item, amount: e.amount }
  })
}

/** Read a `string[]` id list off a prototype field, validating its shape. */
function idList(proto: Prototype, field: string): string[] {
  const raw = proto[field]
  if (raw === undefined) return []
  if (!Array.isArray(raw)) fail(`${proto.id}: "${field}" must be an array`)
  return raw.map((v, i) => {
    if (typeof v !== 'string') fail(`${proto.id}: ${field}[${i}] must be a string id`)
    return v
  })
}

// --- per-type shape checks --------------------------------------------------

function validateRecipeShapes(registry: PrototypeRegistry): void {
  for (const r of registry.listByType('recipe')) {
    if (typeof r.category !== 'string' || r.category.length === 0) {
      fail(`${r.id}: recipe needs a non-empty "category"`)
    }
    flows(r, 'ingredients')
    const results = flows(r, 'results')
    if (results.length === 0) fail(`${r.id}: recipe needs at least one result`)
    if (typeof r.time !== 'number' || !Number.isInteger(r.time) || r.time <= 0) {
      fail(`${r.id}: recipe "time" must be a positive integer`)
    }
    if (r.requiresTerrain !== undefined && typeof r.requiresTerrain !== 'string') {
      fail(`${r.id}: recipe "requiresTerrain" must be a terrain id`)
    }
  }
}

function validateTechShapes(registry: PrototypeRegistry): void {
  for (const t of registry.listByType('technology')) {
    idList(t, 'prerequisites')
    const unlocks = idList(t, 'unlocks')
    if (unlocks.length === 0) fail(`${t.id}: technology must "unlocks" at least one id`)
    // `cost` is the research-pack requirement consumed to research the tech; optional (a root
    // tech seeded as researched needs none), but when present it must be a well-formed flow list.
    flows(t, 'cost')
  }
}

function validateCrafterShapes(registry: PrototypeRegistry): void {
  for (const c of registry.listByType('crafter')) {
    const cats = idList(c, 'craftingCategories')
    if (cats.length === 0) fail(`${c.id}: crafter needs at least one "craftingCategories" entry`)
    if (c.speed !== undefined && (typeof c.speed !== 'number' || c.speed <= 0)) {
      fail(`${c.id}: crafter "speed" must be a positive number`)
    }
    if (c.storage !== undefined && (typeof c.storage !== 'number' || c.storage < 0)) {
      fail(`${c.id}: crafter "storage" must be a non-negative number`)
    }
  }
}

/** The `{ item, ratePerMin }` demands across every stage of a village prototype. */
function villageDemands(proto: Prototype): { item: string; ratePerMin: number }[] {
  const stages = proto.stages
  if (stages === undefined) return []
  if (!Array.isArray(stages)) fail(`${proto.id}: village "stages" must be an array`)
  const out: { item: string; ratePerMin: number }[] = []
  stages.forEach((raw, si) => {
    if (typeof raw !== 'object' || raw === null)
      fail(`${proto.id}: stages[${si}] must be an object`)
    const stage = raw as Record<string, unknown>
    const demands = stage.demands
    if (demands !== undefined && !Array.isArray(demands)) {
      fail(`${proto.id}: stages[${si}].demands must be an array`)
    }
    const list = Array.isArray(demands) ? demands : []
    list.forEach((d, di) => {
      if (typeof d !== 'object' || d === null)
        fail(`${proto.id}: stages[${si}].demands[${di}] must be an object`)
      const dem = d as Record<string, unknown>
      if (typeof dem.item !== 'string')
        fail(`${proto.id}: stages[${si}].demands[${di}].item must be a string`)
      if (typeof dem.ratePerMin !== 'number' || dem.ratePerMin <= 0) {
        fail(`${proto.id}: stages[${si}].demands[${di}].ratePerMin must be a positive number`)
      }
      out.push({ item: dem.item, ratePerMin: dem.ratePerMin })
    })
  })
  return out
}

/**
 * Max stockpile slots / stage demands a single village may carry — mirrors the sim's `MAX_SLOTS` /
 * `MAX_VILLAGE_DEMANDS` (both 8). A village that accepts more than this, or lists more demands in one
 * stage, would silently overflow the fixed typed-array buffers, so reject it at load.
 */
const MAX_VILLAGE_SLOTS = 8

/**
 * Validate every village prototype's stage ladder: demand shapes, the slot/demand caps, and that
 * every demanded item is in the village's `accepts` (a village only stocks — and so can only satisfy
 * — the resources it accepts; a demand outside that list could never be met).
 */
function validateVillageShapes(registry: PrototypeRegistry): void {
  for (const village of registry.listByType('village')) {
    villageDemands(village)
    const accepts = idList(village, 'accepts')
    if (accepts.length > MAX_VILLAGE_SLOTS) {
      fail(`${village.id}: a village may "accepts" at most ${MAX_VILLAGE_SLOTS} items`)
    }
    const acceptSet = new Set(accepts)
    const stages = Array.isArray(village.stages) ? village.stages : []
    stages.forEach((raw, si) => {
      const stage = (raw ?? {}) as Record<string, unknown>
      const demands = Array.isArray(stage.demands) ? stage.demands : []
      if (demands.length > MAX_VILLAGE_SLOTS) {
        fail(`${village.id}: stages[${si}] lists more than ${MAX_VILLAGE_SLOTS} demands`)
      }
      for (const d of demands) {
        const item = (d as Record<string, unknown>)?.item
        if (typeof item === 'string' && !acceptSet.has(item)) {
          fail(`${village.id}: stages[${si}] demands "${item}" which is not in "accepts"`)
        }
      }
    })
  }
}

/** Read a `{ min, max }` positive-integer range off a scenario field (min <= max). */
function intRange(proto: Prototype, field: string): { min: number; max: number } {
  const raw = proto[field]
  if (typeof raw !== 'object' || raw === null)
    fail(`${proto.id}: "${field}" must be a { min, max }`)
  const r = raw as Record<string, unknown>
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0
  if (!ok(r.min) || !ok(r.max)) fail(`${proto.id}: ${field}.min/max must be positive integers`)
  if ((r.min as number) > (r.max as number))
    fail(`${proto.id}: ${field}.min must be <= ${field}.max`)
  return { min: r.min as number, max: r.max as number }
}

/** The `{ item, amount }[]` starting-kit stock a scenario grants the village at spawn. */
function startingKit(proto: Prototype): { item: string; amount: number }[] {
  return flows(proto, 'startingKit')
}

/** The `{ item, amount }[]` starting balance a scenario seeds into the build-cost treasury. */
function startingTreasury(proto: Prototype): { item: string; amount: number }[] {
  return flows(proto, 'startingTreasury')
}

/**
 * Validate a scenario's optional deposit-`richness` band (G1 finite deposits — the scene rolls each
 * deposit tile's units from it). Absent or the string `"infinite"` means infinite richness (a deposit
 * that never depletes — allowed); anything else must be a `{ min, max }` positive-integer range (min ≤ max).
 */
function validateRichness(proto: Prototype): void {
  const raw = proto.richness
  if (raw === undefined || raw === 'infinite') return
  intRange(proto, 'richness')
}

/**
 * A scenario's win goal (G5) — `{ village, stage }`, meaning "raise settlement `village` to stage
 * `stage`". Absent → `null` (a scenario may declare no goal). Shape-validated here (village id +
 * non-negative integer stage); the referenced village and the stage's upper bound are checked in
 * {@link validateContent} where the whole registry is available. Returns the parsed goal (for those
 * checks). Kept a small object so a later delivered-items goal variant can extend it additively.
 */
function goal(proto: Prototype): { village: string; stage: number } | null {
  const raw = proto.goal
  if (raw === undefined) return null
  if (typeof raw !== 'object' || raw === null)
    fail(`${proto.id}: "goal" must be a { village, stage }`)
  const g = raw as Record<string, unknown>
  if (typeof g.village !== 'string') fail(`${proto.id}: goal.village must be a village id`)
  if (typeof g.stage !== 'number' || !Number.isInteger(g.stage) || g.stage < 0) {
    fail(`${proto.id}: goal.stage must be a non-negative integer`)
  }
  return { village: g.village as string, stage: g.stage as number }
}

/**
 * The `{ item, amount }[]` a building/belt/port/… costs from the treasury to place. Empty for a
 * free placement. The prototype types that may bear a `buildCost` (everything the player can build).
 */
export const COST_BEARING_TYPES = [
  'crafter',
  'building',
  'belt',
  'splitter',
  'underground',
  'input',
  'output',
  'village',
] as const

/** Read and shape-validate a prototype's `buildCost` flow list (item id + positive amount). */
export function buildCostOf(proto: Prototype): { item: string; amount: number }[] {
  return flows(proto, 'buildCost')
}

/** Shape-check every cost-bearing prototype's `buildCost` (empty/absent is fine — a free build). */
function validateBuildCostShapes(registry: PrototypeRegistry): void {
  for (const type of COST_BEARING_TYPES) {
    for (const p of registry.listByType(type)) {
      buildCostOf(p)
      // The optional per-cadence credit `upkeep` (G6): a non-negative integer when present.
      if (
        p.upkeep !== undefined &&
        (typeof p.upkeep !== 'number' || !Number.isInteger(p.upkeep) || p.upkeep < 0)
      ) {
        fail(`${p.id}: "upkeep" must be a non-negative integer`)
      }
    }
  }
}

/**
 * A scenario's optional `settlements` (extra villages beyond the origin spaceport, G3): each entry a
 * `{ building, distance: { min, max } }`. Shape-validated here; the referenced `building` is checked
 * to be a `village` prototype by the reference pass in {@link validateContent}. Returns the parsed
 * building ids (for that reference check).
 */
function settlements(proto: Prototype): string[] {
  const raw = proto.settlements
  if (raw === undefined) return []
  if (!Array.isArray(raw)) fail(`${proto.id}: "settlements" must be an array`)
  return raw.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null)
      fail(`${proto.id}: settlements[${i}] must be an object`)
    const e = entry as Record<string, unknown>
    if (typeof e.building !== 'string')
      fail(`${proto.id}: settlements[${i}].building must be a building id`)
    const d = e.distance
    if (typeof d !== 'object' || d === null)
      fail(`${proto.id}: settlements[${i}].distance must be a { min, max }`)
    const dist = d as Record<string, unknown>
    const ok = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0
    if (!ok(dist.min) || !ok(dist.max))
      fail(`${proto.id}: settlements[${i}].distance.min/max must be positive integers`)
    if ((dist.min as number) > (dist.max as number))
      fail(`${proto.id}: settlements[${i}].distance.min must be <= distance.max`)
    return e.building
  })
}

/**
 * Validate every scenario prototype's shape: a non-empty terrain `deposits` list, positive-integer
 * `patchSize`/`spread` ranges, a well-formed `startingKit` flow list, and any `settlements` band.
 * The starting scene ({@link import('./scene.ts')}) reads these to lay out a seed-varied but
 * reproducible world.
 */
function validateScenarioShapes(registry: PrototypeRegistry): void {
  for (const s of registry.listByType('scenario')) {
    const deposits = idList(s, 'deposits')
    if (deposits.length === 0) fail(`${s.id}: scenario needs at least one "deposits" terrain id`)
    intRange(s, 'patchSize')
    intRange(s, 'spread')
    validateRichness(s)
    startingKit(s)
    startingTreasury(s)
    settlements(s)
    goal(s)
  }
}

// --- graph / reference rules ------------------------------------------------

/** Every category some crafter advertises. */
function providedCategories(registry: PrototypeRegistry): Set<string> {
  const provided = new Set<string>()
  for (const c of registry.listByType('crafter')) {
    for (const cat of idList(c, 'craftingCategories')) provided.add(cat)
  }
  return provided
}

/** Assert every recipe's `category` is provided by at least one crafter. */
function validateCategoriesCovered(registry: PrototypeRegistry): void {
  const provided = providedCategories(registry)
  for (const r of registry.listByType('recipe')) {
    if (typeof r.category === 'string' && !provided.has(r.category)) {
      fail(`${r.id}: no crafter provides category "${r.category}"`)
    }
  }
}

/** Assert the recipe production graph is a DAG (no A→B→A). */
function validateRecipeAcyclic(registry: PrototypeRegistry): void {
  const recipes = registry.listByType('recipe')
  // item id -> ids of recipes that produce it (a raw material has none).
  const producers = new Map<string, string[]>()
  for (const r of recipes) {
    for (const out of flows(r, 'results')) {
      const list = producers.get(out.item) ?? []
      list.push(r.id)
      producers.set(out.item, list)
    }
  }
  // A recipe depends on the recipes that produce its ingredients; ingredients with no
  // producing recipe are raw inputs (ignored).
  assertAcyclic(
    recipes,
    (r) => r.id,
    (r) => flows(r, 'ingredients').flatMap((f) => producers.get(f.item) ?? []),
    { onMissing: 'ignore' },
  )
}

/**
 * Validate all authored recipe/technology/crafter (and village, added in the village phase)
 * content. Throws {@link PrototypeError} on the first problem.
 */
export function validateContent(registry: PrototypeRegistry): void {
  validateRecipeShapes(registry)
  validateTechShapes(registry)
  validateCrafterShapes(registry)
  validateVillageShapes(registry)
  validateScenarioShapes(registry)
  validateBuildCostShapes(registry)

  validateReferences(registry, [
    // Every cost-bearing type's `buildCost` must reference known items.
    ...COST_BEARING_TYPES.map((type) => ({
      type,
      select: (p: Prototype) => buildCostOf(p).map((c) => c.item),
      expectType: 'item',
      label: 'buildCost',
    })),
    {
      type: 'recipe',
      select: (r) => flows(r, 'ingredients').map((f) => f.item),
      expectType: 'item',
      label: 'ingredient',
    },
    {
      type: 'recipe',
      select: (r) => flows(r, 'results').map((f) => f.item),
      expectType: 'item',
      label: 'result',
    },
    {
      type: 'recipe',
      select: (r) => (typeof r.requiresTerrain === 'string' ? [r.requiresTerrain] : []),
      expectType: 'terrain',
      label: 'requiresTerrain',
    },
    {
      type: 'technology',
      select: (t) => idList(t, 'prerequisites'),
      expectType: 'technology',
      label: 'prerequisite',
    },
    {
      type: 'technology',
      select: (t) => flows(t, 'cost').map((f) => f.item),
      expectType: 'item',
      label: 'cost',
    },
    // Unlocks may reference a recipe OR a building/crafter; check existence here and the
    // recipe/building type separately below so the message stays specific.
    { type: 'technology', select: (t) => idList(t, 'unlocks'), label: 'unlock' },
    {
      type: 'village',
      select: (v) => villageDemands(v).map((d) => d.item),
      expectType: 'item',
      label: 'demand',
    },
    {
      type: 'scenario',
      select: (s) => idList(s, 'deposits'),
      expectType: 'terrain',
      label: 'deposit',
    },
    {
      type: 'scenario',
      select: (s) => startingKit(s).map((k) => k.item),
      expectType: 'item',
      label: 'startingKit',
    },
    {
      type: 'scenario',
      select: (s) => startingTreasury(s).map((k) => k.item),
      expectType: 'item',
      label: 'startingTreasury',
    },
    {
      type: 'scenario',
      select: (s) => settlements(s),
      expectType: 'village',
      label: 'settlement',
    },
    {
      type: 'scenario',
      select: (s) => {
        const g = goal(s)
        return g ? [g.village] : []
      },
      expectType: 'village',
      label: 'goal',
    },
  ])

  // A scenario goal's stage must exist on its target village's ladder (the reference pass above
  // already proved the village exists and is a `village`). An out-of-range stage could never be
  // reached, so it is a content error — reject it loud at load rather than shipping an unwinnable goal.
  for (const s of registry.listByType('scenario')) {
    const g = goal(s)
    if (g === null) continue
    const village = registry.require(g.village)
    const stages = Array.isArray(village.stages) ? village.stages : []
    if (g.stage >= stages.length) {
      fail(
        `${s.id}: goal.stage ${g.stage} is out of range for "${g.village}" (0..${stages.length - 1})`,
      )
    }
  }

  // Each unlock must resolve to a recipe or a building-like prototype (crafter/building/…).
  const buildableTypes = new Set([
    'recipe',
    'crafter',
    'building',
    'belt',
    'splitter',
    'underground',
    'input',
    'output',
  ])
  for (const t of registry.listByType('technology')) {
    for (const id of idList(t, 'unlocks')) {
      const target = registry.require(id)
      if (!buildableTypes.has(target.type)) {
        fail(`${t.id}: unlock "${id}" must be a recipe or building, got "${target.type}"`)
      }
    }
  }

  validateCategoriesCovered(registry)
  validateRecipeAcyclic(registry)
  assertAcyclic(
    registry.listByType('technology'),
    (t) => t.id,
    (t) => idList(t, 'prerequisites'),
  )
}

// --- buildable-set derivation ----------------------------------------------

/** The minimal prototype shape {@link buildableSet} needs (works on registry or UI copies). */
export interface BuildableProto {
  readonly id: string
  readonly type: string
  readonly unlocks?: unknown
  readonly prerequisites?: unknown
}

/**
 * The set of recipe/building ids that are buildable given the `researched` technologies. An id
 * a technology gates via `unlocks` is buildable only once a researched tech unlocks it; an id no
 * technology gates is always buildable. Pure and one-way (content → UI).
 */
export function buildableSet(
  prototypes: readonly BuildableProto[],
  researched: ReadonlySet<string>,
): Set<string> {
  // Which ids are gated by *some* technology, and which are unlocked by a *researched* one.
  const gated = new Set<string>()
  const unlocked = new Set<string>()
  for (const p of prototypes) {
    if (p.type !== 'technology') continue
    const unlocks = Array.isArray(p.unlocks) ? (p.unlocks as unknown[]) : []
    for (const raw of unlocks) {
      if (typeof raw !== 'string') continue
      gated.add(raw)
      if (researched.has(p.id)) unlocked.add(raw)
    }
  }
  const buildable = new Set<string>()
  for (const p of prototypes) {
    if (!gated.has(p.id) || unlocked.has(p.id)) buildable.add(p.id)
  }
  return buildable
}

/** One selectable starting scenario, as the new-game screen shows it (content → UI, one-way). */
export interface ScenarioInfo {
  readonly id: string
  readonly name: string
  readonly info: string
}

/**
 * Every authored `scenario` prototype as a `{ id, name, info }` list for the new-game picker.
 * Pure (works on a registry's `list()` or a UI-side prototype copy); the host passes the chosen
 * id back into the base mod's new-game closure, which lays out the seed-varied scene from it.
 */
export function scenarioList(
  prototypes: readonly { id: string; type: string; name?: unknown; info?: unknown }[],
): ScenarioInfo[] {
  const out: ScenarioInfo[] = []
  for (const p of prototypes) {
    if (p.type !== 'scenario') continue
    out.push({
      id: p.id,
      name: typeof p.name === 'string' ? p.name : p.id,
      info: typeof p.info === 'string' ? p.info : '',
    })
  }
  return out
}

/** Every technology id in `prototypes` (the "everything researched" seed used until a research loop lands). */
export function allTechIds(prototypes: readonly BuildableProto[]): Set<string> {
  const ids = new Set<string>()
  for (const p of prototypes) if (p.type === 'technology') ids.add(p.id)
  return ids
}

// --- item prices: the credit economy's colour→price table -------------------

/** One item's integer credit price paired with the resource colour the sim keys it by. */
export interface ColorPrice {
  readonly color: number
  readonly price: number
}

/**
 * Compute the credit price of every item colour from the recipe DAG — the HOST side of the credit
 * economy (G6). It unfolds each item to its raw leaves + embodied machine-time via the shared
 * pricing math ({@link computeItemPrices}, the same formula `apps/balance` reports), then maps each
 * item id to the colour the sim identifies it by. The sim never sees an item id: this table is
 * handed to it (via `base:ready`'s `setPrices`) exactly like the other colour-keyed config, and it
 * looks a price up by colour to charge build costs and credit depot deposits.
 *
 * A raw leaf with no recipe (none in the base game, but a modder could add one) is priced at the
 * default weight (1). Deterministic and pure — the integers are stable for a given content set.
 */
export function itemColorPrices(registry: PrototypeRegistry): ColorPrice[] {
  const recipes: PriceRecipe[] = registry.listByType('recipe').map((r) => ({
    id: r.id,
    category: typeof r.category === 'string' ? r.category : '',
    ingredients: flows(r, 'ingredients'),
    results: flows(r, 'results'),
    time: typeof r.time === 'number' ? r.time : 1,
  }))
  // category id → fastest crafter speed providing it (missing → 1), so faster machines cost less.
  const categorySpeed = new Map<string, number>()
  for (const c of registry.listByType('crafter')) {
    const speed = typeof c.speed === 'number' && c.speed > 0 ? c.speed : 1
    for (const cat of idList(c, 'craftingCategories')) {
      categorySpeed.set(cat, Math.max(categorySpeed.get(cat) ?? 0, speed))
    }
  }
  const prices = computeItemPrices(recipes, { categorySpeed })
  const out: ColorPrice[] = []
  for (const item of registry.listByType('item')) {
    const color = typeof item.color === 'number' ? item.color : 0xffffff
    out.push({ color, price: prices.get(item.id)?.price ?? 1 })
  }
  return out
}
