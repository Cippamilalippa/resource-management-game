import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { encyclopediaStore, type EncyclopediaEntry } from './encyclopedia.ts'
import { Icon } from './Icon.tsx'
import { ResourceLabel } from './ResourceLabel.tsx'

/** A recipe's ingredients or products as resource swatches with amounts. */
function Flows({
  flows,
}: {
  flows: readonly { color: number; amount: number }[]
}): React.JSX.Element {
  if (flows.length === 0) return <span className="enc-none">—</span>
  return (
    <span className="enc-flows">
      {flows.map((f, i) => (
        <span key={i} className="enc-flow">
          <span className="enc-amt">{f.amount}×</span>
          <ResourceLabel color={f.color} size={14} />
        </span>
      ))}
    </span>
  )
}

/** One recipe card: inputs → outputs, the machine that runs it, and its craft time. */
function EntryCard({ entry }: { entry: EncyclopediaEntry }): React.JSX.Element {
  return (
    <div className="enc-card">
      <div className="enc-card-head">
        <span className="enc-card-name">{entry.name}</span>
        <span className="enc-card-machine">{entry.machineName}</span>
      </div>
      <div className="enc-card-body">
        <Flows flows={entry.inputs} />
        <Icon name="ArrowRight" size={14} />
        <Flows flows={entry.outputs} />
      </div>
      <div className="enc-card-foot">{entry.craftEvery} ticks / craft</div>
    </div>
  )
}

/**
 * The recipe encyclopedia: a floating "Recipes" button (also on the `E` key) that opens a
 * searchable modal listing every recipe — its machine, ingredients, products and craft time —
 * built read-only from the loaded prototypes. Search matches a recipe/product or machine name.
 */
export function Encyclopedia(): React.JSX.Element {
  const { entries, open } = useSyncExternalStore(
    encyclopediaStore.subscribe,
    encyclopediaStore.get,
    encyclopediaStore.get,
  )
  const [query, setQuery] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      if (e.key === 'e' || e.key === 'E') {
        e.preventDefault()
        encyclopediaStore.toggle()
      } else if (e.key === 'Escape' && open) {
        encyclopediaStore.close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const q = query.trim().toLowerCase()
  const shown = useMemo(
    () =>
      q
        ? entries.filter(
            (e) => e.name.toLowerCase().includes(q) || e.machineName.toLowerCase().includes(q),
          )
        : entries,
    [q, entries],
  )

  return (
    <>
      {open && (
        <div className="enc-modal glass" role="dialog" aria-label="Recipe encyclopedia">
          <div className="enc-head">
            <Icon name="BookOpen" size={16} />
            <span className="enc-title">Recipes</span>
            <div className="enc-search">
              <Icon name="Search" size={14} />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search recipes…"
                aria-label="Search recipes"
                autoFocus
              />
            </div>
            <button
              className="sidebar-close"
              onClick={() => encyclopediaStore.close()}
              aria-label="Close encyclopedia"
            >
              ×
            </button>
          </div>
          <div className="enc-list">
            {shown.length === 0 && <div className="enc-empty">No matching recipes.</div>}
            {shown.map((e) => (
              <EntryCard key={e.id} entry={e} />
            ))}
          </div>
        </div>
      )}
      <button
        className="enc-btn glass"
        onClick={() => encyclopediaStore.toggle()}
        title="Recipes (E)"
        aria-label="Recipes"
        aria-pressed={open}
      >
        <Icon name="BookOpen" size={16} />
        <span>Recipes</span>
      </button>
    </>
  )
}
