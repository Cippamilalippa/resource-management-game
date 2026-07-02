/**
 * Turn a {@link Model} into human-readable tables. Pure string builders — the CLI decides what to
 * print. Kept dumb on purpose: all the judgement lives in `model.ts`.
 */
import type { BalanceConfig } from './config.ts'
import { machineBill, tierCurve, tierFootprint, type Model } from './model.ts'
import type { Dataset } from './types.ts'

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}
function padNum(n: number, width: number, digits = 2): string {
  return (Number.isInteger(n) ? String(n) : n.toFixed(digits)).padStart(width)
}

/** Short "3.0 iron_ore + 1.0 wood" summary of a raw-cost bag, biggest contributor first. */
function rawSummary(raw: ReadonlyMap<string, number>): string {
  return [...raw.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([leaf, qty]) => `${qty.toFixed(1)} ${leaf.replace(/^item\./, '')}`)
    .join(' + ')
}

const short = (id: string): string => id.replace(/^(item|recipe|building)\./, '')

/** Per-item cost table, ordered by tier then composite so the curve reads top-to-bottom. */
export function itemTable(model: Model): string {
  const rows = [...model.costs.values()].sort(
    (a, b) => a.tier - b.tier || a.composite - b.composite || a.item.localeCompare(b.item),
  )
  const lines = [
    `${pad('ITEM', 22)}${pad('TIER', 6)}${pad('LABOR(s)', 11)}${pad('COMPOSITE', 11)}RAW COST`,
    '-'.repeat(90),
  ]
  for (const c of rows) {
    lines.push(
      pad(short(c.item), 22) +
        pad(String(c.tier), 6) +
        pad(c.laborSeconds.toFixed(2), 11) +
        pad(c.composite.toFixed(2), 11) +
        rawSummary(c.raw),
    )
  }
  return lines.join('\n')
}

/** Tier cost-curve summary with the growth multiplier and any balance flags. */
export function tierTable(model: Model, config: BalanceConfig): string {
  const rows = tierCurve(model, config)
  const lines = [
    `${pad('TIER', 6)}${pad('#', 5)}${pad('MEDIAN', 10)}${pad('MAX', 10)}${pad('GROWTH', 9)}FLAGS`,
    '-'.repeat(72),
  ]
  for (const r of rows) {
    lines.push(
      pad(String(r.tier), 6) +
        pad(String(r.count), 5) +
        padNum(r.medianComposite, 8) +
        '  ' +
        padNum(r.maxComposite, 8) +
        '  ' +
        pad(r.multiplier === undefined ? '—' : `${r.multiplier.toFixed(2)}×`, 9) +
        (r.flags.length ? '⚠ ' + r.flags.join('; ') : 'ok'),
    )
  }
  return lines.join('\n')
}

/** Machine bill for each terminal good at a reference throughput. */
export function billTable(
  data: Dataset,
  model: Model,
  config: BalanceConfig,
  ratePerSec: number,
): string {
  const lines: string[] = []
  for (const item of model.terminals) {
    const cost = model.costs.get(item)
    if (!cost || cost.tier === 0) continue // skip bare raws — a bill of one extractor is noise
    lines.push(`\n▸ ${short(item)} @ ${ratePerSec}/s  (${rawSummary(cost.raw)} raw per unit)`)
    for (const step of machineBill(data, model, item, ratePerSec, config)) {
      lines.push(
        '   ' +
          pad(`${step.machines.toFixed(2)}× ${short(step.recipe)}`, 30) +
          pad(`[${step.category}]`, 16) +
          `${step.outputPerSec.toFixed(2)}/s`,
      )
    }
  }
  return lines.length ? lines.join('\n') : '(no multi-tier terminal goods)'
}

/**
 * Machine-tier footprint for each terminal good: total crafters to sustain a rate at mk1 vs each
 * upgrade. Makes the "upgrade to go faster" loop legible — the count collapsing across tiers is
 * the payoff the player is buying. Skipped when no category has more than one tier (nothing to
 * compare).
 */
export function footprintTable(
  data: Dataset,
  model: Model,
  config: BalanceConfig,
  ratePerSec: number,
): string {
  const multiTier = [...data.categoryTiers.values()].some((t) => t.length > 1)
  if (!multiTier) return '(no machine tiers defined — every category has a single crafter speed)'

  const lines: string[] = []
  for (const item of model.terminals) {
    const cost = model.costs.get(item)
    if (!cost || cost.tier === 0) continue // bare raws: one extractor, nothing to compare
    const tiers = tierFootprint(data, model, item, ratePerSec, config)
    const cells = tiers
      .map((t) => `${t.label} ${padNum(t.totalMachines, 6)} (${t.speedup.toFixed(1)}×)`)
      .join('   ')
    lines.push(`${pad(short(item), 20)} @ ${ratePerSec}/s   ${cells}`)
  }
  return lines.length ? lines.join('\n') : '(no multi-tier terminal goods)'
}

/** Mermaid flow-chart of the production DAG — paste into any Mermaid viewer. */
export function mermaid(data: Dataset, model: Model): string {
  const lines = ['flowchart LR']
  for (const cost of model.costs.values()) {
    if (!cost.producedBy) continue
    const recipe = data.recipes.find((r) => r.id === cost.producedBy)
    if (!recipe) continue
    for (const ing of recipe.ingredients) {
      lines.push(`  ${short(ing.item)} --> ${short(cost.item)}`)
    }
  }
  return lines.join('\n')
}
