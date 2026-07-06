/**
 * In-game rate & ratio helper — the pure per-machine throughput math the offline balance analyzer
 * (`apps/balance`) applies statically, surfaced where the player actually builds. Given a recipe's
 * `time` (in sim ticks), its flow amounts, and the `speed` of the crafter that runs its category,
 * it reports per-minute in/out rates; and, one level deep, how many upstream machines it takes to
 * sustain one of a selected crafter.
 *
 * Kept here (not in `packages/shared`) on purpose: this is game-specific content math — recipes,
 * crafters, crafting categories — and `@factory/shared` must stay game-agnostic. It is a minimal,
 * self-contained extraction (rate + one-level ratio), NOT a copy of the balance analyzer's DAG
 * unfolding. Pure and deterministic: built once at boot from the loaded prototypes and read by the
 * recipe picker and the encyclopedia. It never reads or writes sim state, so determinism is safe.
 *
 * The canonical producer of an item is chosen exactly as `apps/balance` does (see its
 * `resolveCanonical` in `model.ts`): a config override wins, else the sole producing recipe, else
 * the lexicographically smallest recipe id — a deterministic pick that keeps this in-game hint and
 * the offline balance report in agreement.
 */
import type { ClientPrototype } from './sim.ts'

/** Sim ticks per second — the clock the per-minute rates are quoted against. */
const TICKS_PER_SECOND = 60
const SECONDS_PER_MINUTE = 60

/** A recipe flow (ingredient or result) reduced to what the rate math needs. */
interface RateFlow {
  readonly item: string
  readonly amount: number
}

interface RateRecipe {
  readonly id: string
  readonly category: string
  /** Craft duration in sim ticks at crafter speed 1. */
  readonly time: number
  readonly ingredients: readonly RateFlow[]
  readonly results: readonly RateFlow[]
}

/** Per-minute in/out rates for a recipe, in the order its flows are authored. */
export interface RecipeRates {
  readonly inputs: readonly number[]
  readonly outputs: readonly number[]
}

/**
 * One upstream-machine ratio hint: to sustain 1× the selected crafter you need `count`× this
 * crafter making `item`. The direct (one-level) ratio only — not the whole production tree.
 */
export interface RatioHint {
  /** The intermediate item this upstream machine makes. */
  readonly item: string
  /** Its packed identity colour, for a ResourceLabel icon. */
  readonly color: number
  /** The crafter that runs the canonical producing recipe (e.g. "Mining Drill"). */
  readonly machineName: string
  /** Machines of that crafter per 1× the selected crafter (e.g. 2.7). */
  readonly count: number
}

/** The derived rate model: pure lookups the recipe UIs read by recipe id. */
export interface RateModel {
  /** Per-minute in/out rates for `recipeId` (empty arrays if unknown). */
  readonly recipeRates: (recipeId: string) => RecipeRates
  /** One-level upstream machine ratios to sustain 1× the crafter running `recipeId`. */
  readonly ratioHints: (recipeId: string) => readonly RatioHint[]
}

/**
 * Units per minute a flow of `amount` sustains at `time` ticks per craft and crafter `speed`.
 * Rate/sec = amount · speed · (ticks/sec ÷ time); ×60 for per-minute. `time ≤ 0` yields 0.
 */
export function flowPerMinute(amount: number, time: number, speed: number): number {
  if (time <= 0) return 0
  return (amount * speed * TICKS_PER_SECOND * SECONDS_PER_MINUTE) / time
}

/**
 * Compact display of a rate/count: whole numbers stay bare, otherwise 1–2 significant decimals with
 * trailing zeros trimmed (e.g. 12 → "12", 2.6667 → "2.7", 0.125 → "0.13"). Pure string formatting.
 */
export function formatRate(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (value === 0) return '0'
  const decimals = value >= 100 ? 0 : value >= 10 ? 1 : 2
  return Number(value.toFixed(decimals)).toString()
}

/** Read a numeric prototype field, falling back when absent/ill-typed. */
function num(proto: ClientPrototype, key: string, fallback: number): number {
  const v = proto[key]
  return typeof v === 'number' ? v : fallback
}

/** Coerce an authored `{ item, amount }[]` field into normalized rate flows. */
function toRateFlows(raw: unknown): RateFlow[] {
  if (!Array.isArray(raw)) return []
  const out: RateFlow[] = []
  for (const entry of raw as { item?: unknown; amount?: unknown }[]) {
    if (typeof entry?.item !== 'string') continue
    out.push({ item: entry.item, amount: typeof entry.amount === 'number' ? entry.amount : 1 })
  }
  return out
}

/** Units of `item` a recipe yields per craft (0 if it is not one of the results). */
function yieldOf(recipe: RateRecipe, item: string): number {
  let total = 0
  for (const r of recipe.results) if (r.item === item) total += r.amount
  return total
}

/**
 * Build the rate model from the loaded prototypes. `overrides` mirrors `apps/balance`'s
 * `preferredRecipes` (item id → recipe id) to pin a canonical producer where several recipes make
 * the same item; empty by default, matching the balance tool's default config.
 */
export function buildRateModel(
  prototypes: readonly ClientPrototype[],
  overrides: Readonly<Record<string, string>> = {},
): RateModel {
  const itemColor = new Map<string, number>()
  const recipes = new Map<string, RateRecipe>()
  // category id → fastest crafter speed and the name of that crafter (the canonical machine).
  const categorySpeed = new Map<string, number>()
  const categoryMachine = new Map<string, string>()
  // item id → every recipe that produces it (to resolve the canonical one).
  const producers = new Map<string, RateRecipe[]>()

  for (const p of prototypes) {
    if (p.type === 'item') {
      itemColor.set(p.id, num(p, 'color', 0xffffff) >>> 0)
    } else if (p.type === 'recipe') {
      const category = typeof p.category === 'string' ? p.category : ''
      if (!category) continue
      const recipe: RateRecipe = {
        id: p.id,
        category,
        time: num(p, 'time', 0),
        ingredients: toRateFlows(p.ingredients),
        results: toRateFlows(p.results),
      }
      recipes.set(recipe.id, recipe)
      for (const r of recipe.results) {
        const list = producers.get(r.item)
        if (list) list.push(recipe)
        else producers.set(r.item, [recipe])
      }
    } else if (p.type === 'crafter') {
      const cats = Array.isArray(p.craftingCategories) ? p.craftingCategories : []
      const speed = num(p, 'speed', 1)
      const name = typeof p.name === 'string' ? p.name : p.id
      for (const c of cats) {
        if (typeof c !== 'string') continue
        // Fastest crafter wins the category (best-case ratio); tie-break by name for determinism.
        const prev = categorySpeed.get(c) ?? -Infinity
        if (speed > prev || (speed === prev && name < (categoryMachine.get(c) ?? ''))) {
          categorySpeed.set(c, speed)
          categoryMachine.set(c, name)
        }
      }
    }
  }

  const speedOf = (category: string): number => categorySpeed.get(category) ?? 1

  /** The single recipe used to cost an item: override, else sole producer, else smallest id. */
  const canonicalProducer = (item: string): RateRecipe | undefined => {
    const list = producers.get(item)
    if (!list || list.length === 0) return undefined
    if (list.length === 1) return list[0]
    const override = overrides[item]
    const pinned = override ? list.find((r) => r.id === override) : undefined
    return pinned ?? [...list].sort((a, b) => a.id.localeCompare(b.id))[0]
  }

  const recipeRates = (recipeId: string): RecipeRates => {
    const recipe = recipes.get(recipeId)
    if (!recipe) return { inputs: [], outputs: [] }
    const speed = speedOf(recipe.category)
    return {
      inputs: recipe.ingredients.map((f) => flowPerMinute(f.amount, recipe.time, speed)),
      outputs: recipe.results.map((f) => flowPerMinute(f.amount, recipe.time, speed)),
    }
  }

  const ratioHints = (recipeId: string): readonly RatioHint[] => {
    const recipe = recipes.get(recipeId)
    if (!recipe) return []
    const selfSpeed = speedOf(recipe.category)
    const hints: RatioHint[] = []
    for (const ing of recipe.ingredients) {
      const producer = canonicalProducer(ing.item)
      if (!producer) continue // a raw with no producing recipe — nothing upstream to build
      const out = yieldOf(producer, ing.item)
      if (out <= 0) continue
      const consumed = flowPerMinute(ing.amount, recipe.time, selfSpeed)
      const produced = flowPerMinute(out, producer.time, speedOf(producer.category))
      hints.push({
        item: ing.item,
        color: itemColor.get(ing.item) ?? 0xffffff,
        machineName: categoryMachine.get(producer.category) ?? producer.category,
        count: produced > 0 ? consumed / produced : 0,
      })
    }
    // Heaviest upstream demand first — the machine the player must build the most of leads.
    hints.sort((a, b) => b.count - a.count)
    return hints
  }

  return { recipeRates, ratioHints }
}
