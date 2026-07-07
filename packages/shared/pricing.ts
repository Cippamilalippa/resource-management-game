/**
 * @factory/shared/pricing — the pure production-graph pricing math.
 *
 * A single source of truth for "what is one unit of an item worth?", shared by the game HOST
 * (which turns the answer into a colour→price table the credit economy runs on — see
 * `mods/base/scripts/content.ts`) and the `apps/balance` analyzer (which surfaces the same
 * numbers in its report). It unfolds each item down the recipe DAG to its raw leaves plus the
 * embodied machine-seconds to make it, weights the raws, and rounds up to an integer ≥ 1.
 *
 * This mirrors the composite/labor expansion `apps/balance/model.ts` already performs; keeping the
 * price formula here means the game and the balancer never drift. Everything is pure and
 * deterministic — no I/O, no clock, no RNG — so it is unit-testable and reproducible, and the
 * integer prices it yields are all the sim ever sees (no float ever reaches the sim).
 */

/** A `{ item, amount }` ingredient or result entry, as authored in recipes. */
export interface PriceFlow {
  readonly item: string
  readonly amount: number
}

/**
 * The minimal recipe shape the pricing math needs: what it consumes, what it yields, how long it
 * takes, and which crafter category runs it (to look up machine speed). An empty `ingredients`
 * list marks an extraction (a raw source that still costs machine-time).
 */
export interface PriceRecipe {
  readonly id: string
  readonly category: string
  readonly ingredients: readonly PriceFlow[]
  readonly results: readonly PriceFlow[]
  /** Craft duration in sim ticks at crafter speed 1. */
  readonly time: number
}

/** Knobs for {@link computeItemPrices}; every field has a sane default so callers can pass `{}`. */
export interface PricingOptions {
  /** Sim ticks per second — converts a recipe's tick `time` to machine-seconds. Default 60. */
  readonly tickRate?: number
  /** Weight applied to embodied machine-seconds when folding labor into the price. Default 0.5. */
  readonly laborWeight?: number
  /** Weight for a raw leaf not listed in {@link rawWeights}. Default 1 (composite = raw units). */
  readonly defaultRawWeight?: number
  /** Per-raw weight overrides — raise one to make a precious raw score as more expensive. */
  readonly rawWeights?: Readonly<Record<string, number>>
  /** category id → fastest crafter speed providing it (missing → 1). Divides craft time. */
  readonly categorySpeed?: ReadonlyMap<string, number>
  /** Pin a canonical producer for an item made by several recipes (else smallest recipe id wins). */
  readonly preferredRecipes?: Readonly<Record<string, string>>
}

/** The costing of one item: its embodied raws (composite), machine-seconds, and integer price. */
export interface ItemPrice {
  /** Σ embodied raw · weight — the honest value score the price is built on. */
  readonly composite: number
  /** Embodied machine-seconds to produce one unit, whole sub-tree included. */
  readonly laborSeconds: number
  /** The final integer price (≥ 1) the credit economy charges/credits for one unit. */
  readonly price: number
}

/** The default weight the game and balancer both apply to embodied machine-time. */
export const DEFAULT_LABOR_WEIGHT = 0.5

/** Units of `item` a recipe yields per craft (0 if it is not a result). */
function yieldOf(recipe: PriceRecipe, item: string): number {
  let total = 0
  for (const r of recipe.results) if (r.item === item) total += r.amount
  return total
}

/**
 * Resolve, for every produced item, the single recipe used to cost it: its sole producer, else the
 * configured override, else the lexicographically smallest recipe id (a deterministic tie-break).
 * Items no recipe makes never appear here (they are pure raw leaves).
 */
function resolveCanonical(
  recipes: readonly PriceRecipe[],
  preferred: Readonly<Record<string, string>>,
): Map<string, PriceRecipe> {
  const producers = new Map<string, PriceRecipe[]>()
  for (const recipe of recipes) {
    for (const result of recipe.results) {
      const list = producers.get(result.item) ?? []
      list.push(recipe)
      producers.set(result.item, list)
    }
  }
  const canonical = new Map<string, PriceRecipe>()
  for (const [item, list] of producers) {
    if (list.length === 1) {
      canonical.set(item, list[0]!)
      continue
    }
    const override = preferred[item]
    const overridden = override ? list.find((r) => r.id === override) : undefined
    canonical.set(item, overridden ?? [...list].sort((a, b) => a.id.localeCompare(b.id))[0]!)
  }
  return canonical
}

/** Depth-first topological order over produced items (edges: item → its canonical ingredients). */
function topoOrder(canonical: Map<string, PriceRecipe>): string[] {
  const order: string[] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (item: string, chain: readonly string[]): void => {
    const mark = state.get(item)
    if (mark === 'done') return
    if (mark === 'visiting') {
      throw new Error(`[pricing] recipe cycle: ${[...chain, item].join(' -> ')}`)
    }
    state.set(item, 'visiting')
    const recipe = canonical.get(item)
    if (recipe) {
      for (const ing of recipe.ingredients) {
        if (canonical.has(ing.item)) visit(ing.item, [...chain, item])
      }
    }
    state.set(item, 'done')
    order.push(item)
  }
  for (const item of canonical.keys()) visit(item, [])
  return order
}

/**
 * Cost every produced item down to its raw leaves plus embodied machine-time, and round up to an
 * integer price ≥ 1. Memoized over a topological order so each item is unfolded once; a recipe
 * cycle throws (the caller's content validation should have caught it first). `composite` is
 * additive down the tree, so a shared intermediate costs the same however deep it sits. Pure and
 * deterministic. Raw leaves (items no recipe produces) are not keys of the result — the caller
 * prices those at the default (weight, rounded up).
 */
export function computeItemPrices(
  recipes: readonly PriceRecipe[],
  options: PricingOptions = {},
): Map<string, ItemPrice> {
  const tickRate = options.tickRate ?? 60
  const laborWeight = options.laborWeight ?? DEFAULT_LABOR_WEIGHT
  const defaultRawWeight = options.defaultRawWeight ?? 1
  const rawWeights = options.rawWeights ?? {}
  const categorySpeed = options.categorySpeed
  const preferred = options.preferredRecipes ?? {}

  const canonical = resolveCanonical(recipes, preferred)
  const order = topoOrder(canonical)
  const costs = new Map<string, ItemPrice>()

  const weightOf = (raw: string): number => rawWeights[raw] ?? defaultRawWeight
  const secondsPerCraft = (recipe: PriceRecipe): number =>
    recipe.time / tickRate / (categorySpeed?.get(recipe.category) ?? 1)
  const priced = (composite: number, laborSeconds: number): ItemPrice => ({
    composite,
    laborSeconds,
    price: Math.max(1, Math.ceil(composite + laborWeight * laborSeconds)),
  })

  for (const item of order) {
    const recipe = canonical.get(item)!
    const out = yieldOf(recipe, item)

    // Extraction (no ingredients): a raw leaf that still costs the machine-time to pull it.
    if (recipe.ingredients.length === 0) {
      costs.set(item, priced(weightOf(item), out > 0 ? secondsPerCraft(recipe) / out : 0))
      continue
    }

    let composite = 0
    let labor = secondsPerCraft(recipe) / out
    for (const ing of recipe.ingredients) {
      const share = ing.amount / out
      const sub = costs.get(ing.item)
      // A sub-item with a recipe folds in its composite/labor; a bare raw leaf folds in its weight.
      composite += (sub ? sub.composite : weightOf(ing.item)) * share
      if (sub) labor += sub.laborSeconds * share
    }
    costs.set(item, priced(composite, labor))
  }

  return costs
}
