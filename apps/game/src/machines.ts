/**
 * Host-side machine + recipe metadata, derived once from the loaded prototypes. This is the single
 * source of truth for the Factorio-style "one machine, pick its recipe" model: the build bar shows
 * one tool per crafter *building* (not per recipe), and the recipe picker offers the recipes that
 * building's categories can run. The sim only ever tracks an opaque recipe integer id
 * ({@link recipeTypeOf}); this module owns the string↔int map and the item→colour resolution, and
 * hands the sim the concrete `{ color, amount }` flows through the `place_crafter` / `set_recipe`
 * commands. Read-only — it never touches the sim.
 */
import { recipeTypeOf, terrainTypeOf, type CraftFlow } from './gameLogic.ts'
import { buildRateModel, type RatioHint } from './rates.ts'
import type { ClientPrototype } from './sim.ts'

/** A recipe as the picker offers it, pre-resolved to the colours + amounts the sim command needs. */
export interface RecipeChoice {
  readonly id: string
  readonly name: string
  /** Opaque integer id the sim stores on the crafter (see {@link recipeTypeOf}). */
  readonly int: number
  readonly category: string
  readonly inputs: readonly CraftFlow[]
  readonly outputs: readonly CraftFlow[]
  /** Per-minute rate of each input, aligned to {@link inputs} (from `time`, amount, machine speed). */
  readonly inputRates: readonly number[]
  /** Per-minute rate of each output, aligned to {@link outputs}. */
  readonly outputRates: readonly number[]
  /** Direct upstream machine ratios to sustain 1× this crafter (one level; empty for extraction). */
  readonly ratios: readonly RatioHint[]
  /** Attempt one craft every N ticks (recipe `time`). */
  readonly craftEvery: number
  readonly storageCap: number
  /** Primary output colour (for the picker's icon). */
  readonly outputColor: number
  /** Terrain type this recipe needs under the machine, or 0 (none). */
  readonly requiresTerrainType: number
}

/** A placeable crafter building and the recipes it can run. */
export interface MachineDef {
  readonly id: string
  readonly name: string
  readonly color: number
  readonly icon?: string
  readonly w: number
  readonly h: number
  readonly storage: number
  readonly categories: readonly string[]
  /** True when every recipe it runs is terrain-gated (a mine / oil derrick) — recipe auto-picked. */
  readonly extraction: boolean
  readonly recipes: readonly RecipeChoice[]
}

/** The derived machine catalogue plus lookups the build UI / recipe picker index by. */
export interface MachineIndex {
  readonly defs: readonly MachineDef[]
  readonly byColor: ReadonlyMap<number, MachineDef>
  readonly recipeByInt: ReadonlyMap<number, RecipeChoice>
}

/** Read a numeric prototype field, falling back when absent/ill-typed. */
function num(proto: ClientPrototype, key: string, fallback: number): number {
  const v = proto[key]
  return typeof v === 'number' ? v : fallback
}

/** A recipe input/output flow as authored: `{ item, amount }`. */
interface AuthoredFlow {
  item?: string
  amount?: number
}

/** Prettify an id like `recipe.aluminum_sheet` → "Aluminum Sheet". */
function label(id: string): string {
  return id
    .replace(/^(recipe|item)\./, '')
    .split('_')
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ')
}

/**
 * Build the machine catalogue from the prototypes: resolve each recipe's item ids to colours, mint
 * its integer id, and group recipes under the crafter buildings whose `craftingCategories` provide
 * their category. `craftEvery` is the recipe `time` (a machine's `speed` is not yet applied, matching
 * the current sim behaviour); `storageCap` comes from the building.
 */
export function buildMachineIndex(prototypes: readonly ClientPrototype[]): MachineIndex {
  // Per-machine throughput math (per-minute rates + one-level machine ratios), derived once.
  const rates = buildRateModel(prototypes)
  const itemColor = new Map<string, number>()
  const itemName = new Map<string, string>()
  for (const p of prototypes) {
    if (p.type !== 'item') continue
    itemColor.set(p.id, num(p, 'color', 0xffffff))
    if (typeof p.name === 'string') itemName.set(p.id, p.name)
  }
  const colorOf = (id: unknown): number =>
    typeof id === 'string' ? (itemColor.get(id) ?? 0xffffff) : 0xffffff
  const toFlows = (list: unknown): CraftFlow[] =>
    (Array.isArray(list) ? (list as AuthoredFlow[]) : [])
      .filter((f): f is { item: string; amount?: number } => typeof f?.item === 'string')
      .map((f) => ({ color: colorOf(f.item), amount: typeof f.amount === 'number' ? f.amount : 1 }))

  // Recipes grouped by category, so a machine can collect every recipe its categories provide.
  const recipesByCategory = new Map<string, RecipeChoice[]>()
  const recipeByInt = new Map<number, RecipeChoice>()
  for (const p of prototypes) {
    if (p.type !== 'recipe') continue
    const category = typeof p.category === 'string' ? p.category : ''
    if (!category) continue
    const outputs = toFlows(p.results)
    const first = outputs[0]
    if (!first) continue // a recipe with no resolvable output isn't offerable
    const primaryId = (Array.isArray(p.results) ? (p.results as AuthoredFlow[])[0]?.item : '') ?? ''
    const recipeRates = rates.recipeRates(p.id)
    const choice: RecipeChoice = {
      id: p.id,
      name: itemName.get(primaryId) ?? label(p.id),
      int: recipeTypeOf(p.id),
      category,
      inputs: toFlows(p.ingredients),
      outputs,
      inputRates: recipeRates.inputs,
      outputRates: recipeRates.outputs,
      ratios: rates.ratioHints(p.id),
      craftEvery: num(p, 'time', 30),
      storageCap: 100,
      outputColor: first.color,
      requiresTerrainType:
        typeof p.requiresTerrain === 'string' ? terrainTypeOf(p.requiresTerrain) : 0,
    }
    recipeByInt.set(choice.int, choice)
    const bucket = recipesByCategory.get(category)
    if (bucket) bucket.push(choice)
    else recipesByCategory.set(category, [choice])
  }

  const defs: MachineDef[] = []
  const byColor = new Map<number, MachineDef>()
  for (const p of prototypes) {
    if (p.type !== 'crafter') continue
    const categories = (Array.isArray(p.craftingCategories) ? p.craftingCategories : []).filter(
      (c): c is string => typeof c === 'string',
    )
    const storage = num(p, 'storage', 100)
    const recipes: RecipeChoice[] = []
    for (const c of categories) {
      for (const r of recipesByCategory.get(c) ?? []) recipes.push({ ...r, storageCap: storage })
    }
    const size = (p.size ?? {}) as { w?: number; h?: number }
    const color = num(p, 'color', 0xffffff)
    const def: MachineDef = {
      id: p.id,
      name: typeof p.name === 'string' ? p.name : p.id,
      color,
      ...(typeof p.icon === 'string' ? { icon: p.icon } : {}),
      w: typeof size.w === 'number' ? size.w : 1,
      h: typeof size.h === 'number' ? size.h : 1,
      storage,
      categories,
      extraction: recipes.length > 0 && recipes.every((r) => r.requiresTerrainType !== 0),
      recipes,
    }
    defs.push(def)
    byColor.set(color, def)
  }

  return { defs, byColor, recipeByInt }
}
