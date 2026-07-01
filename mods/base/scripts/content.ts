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

/** Validate every village prototype's stage ladder shape. */
function validateVillageShapes(registry: PrototypeRegistry): void {
  for (const village of registry.listByType('village')) villageDemands(village)
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

  validateReferences(registry, [
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
    // Unlocks may reference a recipe OR a building/crafter; check existence here and the
    // recipe/building type separately below so the message stays specific.
    { type: 'technology', select: (t) => idList(t, 'unlocks'), label: 'unlock' },
    {
      type: 'village',
      select: (v) => villageDemands(v).map((d) => d.item),
      expectType: 'item',
      label: 'demand',
    },
  ])

  // Each unlock must resolve to a recipe or a building-like prototype (crafter/building/…).
  const buildableTypes = new Set([
    'recipe',
    'crafter',
    'building',
    'belt',
    'splitter',
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

/** Every technology id in `prototypes` (the "everything researched" seed used until a research loop lands). */
export function allTechIds(prototypes: readonly BuildableProto[]): Set<string> {
  const ids = new Set<string>()
  for (const p of prototypes) if (p.type === 'technology') ids.add(p.id)
  return ids
}
