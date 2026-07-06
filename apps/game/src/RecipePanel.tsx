import { useSyncExternalStore } from 'react'
import { recipeStore } from './recipeStore.ts'
import type { RecipeChoice } from './machines.ts'
import { Icon } from './Icon.tsx'
import { ResourceLabel } from './ResourceLabel.tsx'
import { encyclopediaStore } from './encyclopedia.ts'

/**
 * A recipe's I/O as swatch rows: inputs → output(s). Each swatch click-throughs to the
 * encyclopedia filtered on that item (Q4); `stopPropagation` keeps the click from also firing the
 * enclosing recipe-row button's "set recipe" handler.
 */
function RecipeFlows({ recipe }: { recipe: RecipeChoice }): React.JSX.Element {
  const openItem = (e: React.MouseEvent, color: number): void => {
    e.stopPropagation()
    encyclopediaStore.openForItem(color)
  }
  return (
    <span className="recipe-flows">
      {recipe.inputs.map((f, i) => (
        <span key={`i${i}`} className="recipe-flow">
          <ResourceLabel
            color={f.color}
            size={13}
            showName={false}
            onClick={(e) => openItem(e, f.color)}
          />
          {f.amount}
        </span>
      ))}
      <Icon name="ArrowRight" size={12} />
      {recipe.outputs.map((f, i) => (
        <span key={`o${i}`} className="recipe-flow">
          <ResourceLabel
            color={f.color}
            size={13}
            showName={false}
            onClick={(e) => openItem(e, f.color)}
          />
          {f.amount}
        </span>
      ))}
    </span>
  )
}

/**
 * Recipe picker for the pinned crafter, rendered inside the inspector sidebar. Reads
 * {@link recipeStore} (populated by `placement.ts` when a crafter is pinned) and enqueues a recipe
 * change through the wired controller. Extraction machines (mines/derricks) auto-pick by terrain,
 * so their recipe is shown read-only. Renders nothing when no crafter is pinned.
 */
export function RecipePanel(): React.JSX.Element | null {
  const sel = useSyncExternalStore(recipeStore.subscribe, recipeStore.get, recipeStore.get)
  if (!sel) return null

  const choose = (r: RecipeChoice): void => recipeStore.getController()?.choose(r)

  if (sel.extraction) {
    const active = sel.options.find((o) => o.int === sel.currentInt)
    return (
      <div className="recipe-picker">
        <div className="recipe-head">Recipe · auto (terrain)</div>
        {active ? (
          <div className="recipe-row active">
            <span className="recipe-name">{active.name}</span>
            <RecipeFlows recipe={active} />
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
          {r.int === sel.currentInt && <Icon name="Check" size={12} />}
          <span className="recipe-name">{r.name}</span>
          <RecipeFlows recipe={r} />
        </button>
      ))}
    </div>
  )
}
