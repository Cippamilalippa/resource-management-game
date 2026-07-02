/**
 * The balance model: unfold the recipe DAG down to raw resources and score every item.
 *
 * For each item we compute, memoized over a topological order so each is visited once:
 *   - `raw`    — the bag of raw (leaf) resources embodied in one unit. The honest cost.
 *   - `labor`  — total machine-seconds across the whole sub-tree to make one unit.
 *   - `composite` — a single scalar: Σ raw · weight. The axis the cost curve is drawn on.
 *   - `tier`   — longest path to a raw leaf; the x-axis of that curve.
 *
 * A "raw" (leaf) is any item whose canonical recipe has no ingredients (terrain extraction) or
 * that no recipe produces at all. Recursion stops there and the item is its own unit of raw cost.
 *
 * Everything here is pure and deterministic — no I/O, no clock — so it is unit-testable and its
 * verdicts are reproducible.
 */
import type { BalanceConfig } from './config.ts'
import type { Dataset, Recipe } from './types.ts'

export interface ItemCost {
  readonly item: string
  /** Canonical recipe id that makes this item, or null for a raw/leaf resource. */
  readonly producedBy: string | null
  readonly tier: number
  /** Raw leaf -> quantity embodied per unit of this item. */
  readonly raw: ReadonlyMap<string, number>
  /** Embodied machine-seconds to produce one unit, whole sub-tree included. */
  readonly laborSeconds: number
  /** Σ raw · weight — the composite value score. */
  readonly composite: number
}

export interface Model {
  readonly costs: ReadonlyMap<string, ItemCost>
  /** Topological order of item ids (raws first). */
  readonly order: readonly string[]
  /** Items no recipe consumes as an ingredient — the final goods. */
  readonly terminals: readonly string[]
  readonly warnings: readonly string[]
}

/** Look up how many units of `item` a recipe yields per craft (0 if it is not a result). */
function yieldOf(recipe: Recipe, item: string): number {
  let total = 0
  for (const r of recipe.results) if (r.item === item) total += r.amount
  return total
}

/**
 * Resolve, for every item, the single recipe used to cost it. When several recipes can make an
 * item, honor the config override, else pick the lexicographically smallest recipe id and warn —
 * a deterministic choice that surfaces the ambiguity rather than hiding it.
 */
function resolveCanonical(
  data: Dataset,
  config: BalanceConfig,
  warnings: string[],
): Map<string, Recipe | null> {
  const producers = new Map<string, Recipe[]>()
  for (const recipe of data.recipes) {
    for (const result of recipe.results) {
      const list = producers.get(result.item) ?? []
      list.push(recipe)
      producers.set(result.item, list)
    }
  }

  const canonical = new Map<string, Recipe | null>()
  const allItems = new Set<string>([...data.items.keys(), ...producers.keys()])
  for (const item of allItems) {
    const list = producers.get(item)
    if (!list || list.length === 0) {
      canonical.set(item, null)
      continue
    }
    if (list.length === 1) {
      canonical.set(item, list[0] ?? null)
      continue
    }
    const override = config.preferredRecipes[item]
    const overridden = override ? list.find((r) => r.id === override) : undefined
    const picked = overridden ?? [...list].sort((a, b) => a.id.localeCompare(b.id))[0]!
    if (!overridden) {
      warnings.push(
        `${item}: produced by ${list.length} recipes (${list
          .map((r) => r.id)
          .join(
            ', ',
          )}); costing via "${picked.id}". Pin one in config.preferredRecipes to silence.`,
      )
    }
    canonical.set(item, picked)
  }
  return canonical
}

/** Depth-first topological order over items (edges: item -> its canonical ingredients). */
function topoOrder(canonical: Map<string, Recipe | null>): string[] {
  const order: string[] = []
  const state = new Map<string, 'visiting' | 'done'>()

  const visit = (item: string, chain: readonly string[]): void => {
    const mark = state.get(item)
    if (mark === 'done') return
    if (mark === 'visiting') {
      throw new Error(`[balance] recipe cycle: ${[...chain, item].join(' -> ')}`)
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

export function buildModel(data: Dataset, config: BalanceConfig): Model {
  const warnings: string[] = []
  const canonical = resolveCanonical(data, config, warnings)
  const order = topoOrder(canonical)
  const costs = new Map<string, ItemCost>()

  const weightOf = (raw: string): number => config.rawWeights[raw] ?? config.defaultRawWeight
  const secondsPerCraft = (recipe: Recipe): number =>
    recipe.time / config.tickRate / (data.categorySpeed.get(recipe.category) ?? 1)

  for (const item of order) {
    const recipe = canonical.get(item) ?? null

    // Raw leaf: no recipe, or an extraction recipe with no ingredients.
    if (!recipe || recipe.ingredients.length === 0) {
      costs.set(item, {
        item,
        producedBy: recipe ? recipe.id : null,
        tier: 0,
        raw: new Map([[item, 1]]),
        // An extraction step still costs machine-time; a truly source-less item costs nothing.
        laborSeconds: recipe ? secondsPerCraft(recipe) / yieldOf(recipe, item) : 0,
        composite: weightOf(item),
      })
      continue
    }

    const out = yieldOf(recipe, item)
    const raw = new Map<string, number>()
    let labor = secondsPerCraft(recipe) / out
    let tier = 0

    for (const ing of recipe.ingredients) {
      const share = ing.amount / out
      const sub = costs.get(ing.item)
      if (!sub) {
        // Ingredient outside the topo order (unknown item) — treat as an opaque raw.
        raw.set(ing.item, (raw.get(ing.item) ?? 0) + share)
        warnings.push(`${recipe.id}: ingredient "${ing.item}" has no cost entry; treated as raw.`)
        continue
      }
      for (const [leaf, qty] of sub.raw) raw.set(leaf, (raw.get(leaf) ?? 0) + qty * share)
      labor += sub.laborSeconds * share
      tier = Math.max(tier, sub.tier + 1)
    }

    let composite = 0
    for (const [leaf, qty] of raw) composite += qty * weightOf(leaf)

    costs.set(item, { item, producedBy: recipe.id, tier, raw, laborSeconds: labor, composite })
  }

  // Terminals: items no recipe uses as an ingredient (and that are themselves produced or known).
  const consumed = new Set<string>()
  for (const recipe of data.recipes) for (const ing of recipe.ingredients) consumed.add(ing.item)
  const terminals = order.filter((item) => !consumed.has(item)).sort()

  return { costs, order, terminals, warnings }
}

// --- throughput ratios ------------------------------------------------------

export interface MachineStep {
  readonly recipe: string
  readonly item: string
  readonly category: string
  /** Output rate of this item demanded by the whole build (units/sec). */
  readonly outputPerSec: number
  /** Machines of this recipe's category needed to sustain that rate. */
  readonly machines: number
}

/** item id -> the canonical recipe that makes it (null for a raw with no extraction recipe). */
function canonicalRecipes(data: Dataset, model: Model): Map<string, Recipe | null> {
  const canonicalOf = new Map<string, Recipe | null>()
  for (const [id, cost] of model.costs) {
    canonicalOf.set(
      id,
      cost.producedBy ? (data.recipes.find((r) => r.id === cost.producedBy) ?? null) : null,
    )
  }
  return canonicalOf
}

/**
 * Units/sec required of every item in the sub-tree to sustain `ratePerSec` of `item`, shared
 * intermediates summed. The demand graph both the machine bill and the tier-footprint read.
 */
function unfoldDemand(
  canonicalOf: Map<string, Recipe | null>,
  item: string,
  ratePerSec: number,
): Map<string, number> {
  const demand = new Map<string, number>()
  const add = (target: string, rate: number): void => {
    demand.set(target, (demand.get(target) ?? 0) + rate)
    const recipe = canonicalOf.get(target)
    if (!recipe || recipe.ingredients.length === 0) return
    const out = yieldOf(recipe, target)
    for (const ing of recipe.ingredients) add(ing.item, rate * (ing.amount / out))
  }
  add(item, ratePerSec)
  return demand
}

/**
 * The machine bill to sustain `ratePerSec` units/sec of `item`: how many crafters at each step of
 * its production tree. Rolls up shared intermediates so, e.g., two consumers of iron plate sum
 * into one furnace count. Machine counts assume the fastest crafter available per category (the
 * best case); see {@link tierFootprint} for the per-machine-tier comparison.
 */
export function machineBill(
  data: Dataset,
  model: Model,
  item: string,
  ratePerSec: number,
  config: BalanceConfig,
): MachineStep[] {
  const canonicalOf = canonicalRecipes(data, model)
  const demand = unfoldDemand(canonicalOf, item, ratePerSec)

  const steps: MachineStep[] = []
  for (const [target, rate] of demand) {
    const recipe = canonicalOf.get(target)
    if (!recipe) continue // pure raw with no extraction recipe
    const out = yieldOf(recipe, target)
    const speed = data.categorySpeed.get(recipe.category) ?? 1
    const secondsPerCraft = recipe.time / config.tickRate / speed
    const machines = (rate / out) * secondsPerCraft
    steps.push({
      recipe: recipe.id,
      item: target,
      category: recipe.category,
      outputPerSec: rate,
      machines,
    })
  }
  return steps.sort((a, b) => b.machines - a.machines)
}

// --- machine-tier footprint -------------------------------------------------

export interface FootprintTier {
  /** 0-based tier index; 0 = mk1 (slowest). */
  readonly index: number
  readonly label: string
  /** Total crafters to sustain the target rate if every step runs this tier's machine. */
  readonly totalMachines: number
  /** Shrink factor versus the slowest tier (mk1) — 1 at mk1, grows as machines get faster. */
  readonly speedup: number
}

/**
 * The whole-factory machine footprint to sustain `ratePerSec` of `item`, computed at each machine
 * tier. This is the "upgrade loop made visible": mk1 machines can build anything, but the count
 * needed for a rate is punishing; upgrading each category to a faster crafter collapses it. A step
 * whose category has fewer tiers than the deepest reuses its top tier (it is already maxed).
 */
export function tierFootprint(
  data: Dataset,
  model: Model,
  item: string,
  ratePerSec: number,
  config: BalanceConfig,
): FootprintTier[] {
  const canonicalOf = canonicalRecipes(data, model)
  const demand = unfoldDemand(canonicalOf, item, ratePerSec)

  // How many tiers deep does this good's factory go? (max over the categories it actually uses).
  let tierCount = 1
  for (const target of demand.keys()) {
    const recipe = canonicalOf.get(target)
    if (!recipe) continue
    const tiers = data.categoryTiers.get(recipe.category)
    if (tiers && tiers.length > tierCount) tierCount = tiers.length
  }

  const speedAt = (category: string, index: number): number => {
    const tiers = data.categoryTiers.get(category)
    if (!tiers || tiers.length === 0) return data.categorySpeed.get(category) ?? 1
    return tiers[Math.min(index, tiers.length - 1)] ?? 1
  }

  const rows: FootprintTier[] = []
  let mk1Total = 0
  for (let index = 0; index < tierCount; index++) {
    let total = 0
    for (const [target, rate] of demand) {
      const recipe = canonicalOf.get(target)
      if (!recipe) continue
      const out = yieldOf(recipe, target)
      const secondsPerCraft = recipe.time / config.tickRate / speedAt(recipe.category, index)
      total += (rate / out) * secondsPerCraft
    }
    if (index === 0) mk1Total = total
    rows.push({
      index,
      label: `mk${index + 1}`,
      totalMachines: total,
      speedup: total > 0 ? mk1Total / total : 1,
    })
  }
  return rows
}

// --- cost curve / anomalies -------------------------------------------------

export interface TierRow {
  readonly tier: number
  readonly count: number
  readonly medianComposite: number
  readonly maxComposite: number
  /** medianComposite / previous tier's — undefined for the first non-empty tier. */
  readonly multiplier: number | undefined
  readonly flags: readonly string[]
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

/** Group costs by tier and check the growth curve against the configured bands. */
export function tierCurve(model: Model, config: BalanceConfig): TierRow[] {
  const byTier = new Map<number, ItemCost[]>()
  for (const cost of model.costs.values()) {
    const list = byTier.get(cost.tier) ?? []
    list.push(cost)
    byTier.set(cost.tier, list)
  }

  const rows: TierRow[] = []
  let prevMedian: number | undefined
  for (const tier of [...byTier.keys()].sort((a, b) => a - b)) {
    const costs = byTier.get(tier)!
    const composites = costs.map((c) => c.composite)
    const med = median(composites)
    const max = Math.max(...composites)
    const multiplier = prevMedian && prevMedian > 0 ? med / prevMedian : undefined
    const flags: string[] = []

    if (multiplier !== undefined) {
      if (multiplier < config.tierMultiplier.min) {
        flags.push(
          `growth ${multiplier.toFixed(2)}× below min ${config.tierMultiplier.min}× (too flat)`,
        )
      } else if (multiplier > config.tierMultiplier.max) {
        flags.push(
          `growth ${multiplier.toFixed(2)}× above max ${config.tierMultiplier.max}× (spikes)`,
        )
      }
    }
    for (const c of costs) {
      if (med > 0 && c.composite > med * config.intraTierSpike) {
        flags.push(`${c.item} is ${(c.composite / med).toFixed(1)}× the tier median (outlier)`)
      }
    }

    rows.push({
      tier,
      count: costs.length,
      medianComposite: med,
      maxComposite: max,
      multiplier,
      flags,
    })
    prevMedian = med
  }
  return rows
}
