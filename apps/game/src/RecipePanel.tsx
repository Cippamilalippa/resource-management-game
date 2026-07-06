import { useSyncExternalStore } from 'react'
import { recipeStore } from './recipeStore.ts'
import type { RecipeChoice } from './machines.ts'
import type { RatioHint } from './rates.ts'
import { formatRate } from './rates.ts'
import { Icon } from './Icon.tsx'
import { ResourceLabel } from './ResourceLabel.tsx'

/** A recipe's I/O as swatch rows: inputs → output(s), each with its per-craft amount. */
function RecipeFlows({ recipe }: { recipe: RecipeChoice }): React.JSX.Element {
  return (
    <span className="recipe-flows">
      {recipe.inputs.map((f, i) => (
        <span key={`i${i}`} className="recipe-flow">
          <ResourceLabel color={f.color} size={13} showName={false} />
          {f.amount}
        </span>
      ))}
      <Icon name="ArrowRight" size={12} />
      {recipe.outputs.map((f, i) => (
        <span key={`o${i}`} className="recipe-flow">
          <ResourceLabel color={f.color} size={13} showName={false} />
          {f.amount}
        </span>
      ))}
    </span>
  )
}

/** The per-minute throughput of a recipe on this machine — inputs → outputs, truncated if long. */
function RecipeRateStrip({ recipe }: { recipe: RecipeChoice }): React.JSX.Element {
  const ins = recipe.inputRates.map(formatRate).join(', ')
  const outs = recipe.outputRates.map(formatRate).join(', ')
  const text = recipe.inputRates.length > 0 ? `${ins} → ${outs}/min` : `${outs}/min`
  return (
    <span className="recipe-rates" title={`Per minute — in: ${ins || '—'} · out: ${outs}`}>
      {text}
    </span>
  )
}

/**
 * The direct upstream machine bill: to run one of this crafter, how many of each feeder crafter it
 * takes (one level deep, the way `apps/balance` computes it). Hidden when the recipe has no inputs.
 */
function RatioHints({ ratios }: { ratios: readonly RatioHint[] }): React.JSX.Element | null {
  if (ratios.length === 0) return null
  return (
    <div className="recipe-ratios">
      <div className="recipe-ratios-head">To sustain 1× this machine, feed it:</div>
      {ratios.map((h) => (
        <div
          key={h.item}
          className="recipe-ratio"
          title={`${formatRate(h.count)}× ${h.machineName}`}
        >
          <span className="recipe-ratio-count">{formatRate(h.count)}×</span>
          <span className="recipe-ratio-machine">{h.machineName}</span>
          <ResourceLabel color={h.color} size={13} showName={false} />
        </div>
      ))}
    </div>
  )
}

/**
 * Recipe picker for the pinned crafter, rendered inside the inspector sidebar. Reads
 * {@link recipeStore} (populated by `placement.ts` when a crafter is pinned) and enqueues a recipe
 * change through the wired controller. Every row shows the recipe's per-minute in/out rates on this
 * machine; the assigned recipe also gets a one-level upstream machine-ratio bill. Extraction
 * machines (mines/derricks) auto-pick by terrain, so their recipe is shown read-only. Renders
 * nothing when no crafter is pinned.
 */
export function RecipePanel(): React.JSX.Element | null {
  const sel = useSyncExternalStore(recipeStore.subscribe, recipeStore.get, recipeStore.get)
  if (!sel) return null

  const choose = (r: RecipeChoice): void => recipeStore.getController()?.choose(r)
  const active = sel.options.find((o) => o.int === sel.currentInt)

  if (sel.extraction) {
    return (
      <div className="recipe-picker">
        <div className="recipe-head">Recipe · auto (terrain)</div>
        {active ? (
          <div className="recipe-row active">
            <div className="recipe-row-top">
              <span className="recipe-name">{active.name}</span>
              <RecipeFlows recipe={active} />
            </div>
            <RecipeRateStrip recipe={active} />
          </div>
        ) : (
          <div className="recipe-empty">Place on a matching deposit to extract.</div>
        )}
      </div>
    )
  }

  return (
    <div className="recipe-picker">
      <div className="recipe-head">Recipe</div>
      {sel.options.length === 0 && <div className="recipe-empty">No recipes for this machine.</div>}
      {sel.options.map((r) => (
        <button
          key={r.id}
          className={`recipe-row${r.int === sel.currentInt ? ' active' : ''}`}
          onClick={() => choose(r)}
          title={`Set recipe: ${r.name}`}
        >
          <div className="recipe-row-top">
            {r.int === sel.currentInt && <Icon name="Check" size={12} />}
            <span className="recipe-name">{r.name}</span>
            <RecipeFlows recipe={r} />
          </div>
          <RecipeRateStrip recipe={r} />
        </button>
      ))}
      {active && <RatioHints ratios={active.ratios} />}
    </div>
  )
}
