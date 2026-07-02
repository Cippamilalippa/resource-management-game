/**
 * Balancing knobs. Edit these to steer the analysis — nothing here touches the game at runtime;
 * it only shapes how the model scores and flags content.
 */

export interface BalanceConfig {
  /**
   * How many sim ticks make one second. Only affects the *units* the labor/throughput numbers
   * are reported in (ticks -> seconds); the balance verdicts are unit-independent. Match the
   * scheduler's tick rate so "machines per unit/sec" reads as real machines.
   */
  readonly tickRate: number

  /**
   * Per-raw-resource weights for the composite "value" score. A raw not listed uses
   * `defaultRawWeight`. Raise a weight to say "this raw is precious" (e.g. rare ore) so goods
   * that lean on it score as more expensive. Default (all 1) makes composite = total raw units.
   */
  readonly defaultRawWeight: number
  readonly rawWeights: Readonly<Record<string, number>>

  /**
   * Intended tier-over-tier cost growth band. The report flags any tier whose median composite
   * cost, divided by the previous tier's, falls outside [min, max] — that's the "is the curve
   * smooth?" check. Tighten it as the tree matures.
   */
  readonly tierMultiplier: { readonly min: number; readonly max: number }

  /**
   * Within a single tier, flag any item whose composite cost exceeds this multiple of the tier
   * median — a lone spike that usually means a mis-costed recipe.
   */
  readonly intraTierSpike: number

  /**
   * Pin a canonical producer for items that more than one recipe can make (else the model warns
   * and picks the lexicographically smallest recipe id). Map: item id -> recipe id.
   */
  readonly preferredRecipes: Readonly<Record<string, string>>
}

export const defaultConfig: BalanceConfig = {
  tickRate: 60,
  defaultRawWeight: 1,
  rawWeights: {},
  tierMultiplier: { min: 1.5, max: 3 },
  intraTierSpike: 2.5,
  preferredRecipes: {},
}
