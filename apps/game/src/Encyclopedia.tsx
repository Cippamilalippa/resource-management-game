import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import {
  encyclopediaStore,
  filterEncyclopediaByItem,
  type EncyclopediaEntry,
  type EncyclopediaFlow,
} from './encyclopedia.ts'
import { Icon } from './Icon.tsx'
import { ResourceLabel } from './ResourceLabel.tsx'
import { formatRate } from './rates.ts'
import { priceForColor } from './resources.ts'

/** A recipe's ingredients or products as resource swatches with per-craft amount and /min rate. */
function Flows({ flows }: { flows: readonly EncyclopediaFlow[] }): React.JSX.Element {
  if (flows.length === 0) return <span className="enc-none">—</span>
  return (
    <span className="enc-flows">
      {flows.map((f, i) => (
        <span key={i} className="enc-flow">
          <span className="enc-amt">{f.amount}×</span>
          <ResourceLabel color={f.color} size={14} />
          <span className="enc-rate">{formatRate(f.perMin)}/min</span>
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

/** A named group of recipe cards (e.g. "Produces" / "Consumes" for an item filter). Hidden when empty. */
function EntryGroup({
  label,
  entries,
}: {
  label: string
  entries: readonly EncyclopediaEntry[]
}): React.JSX.Element | null {
  if (entries.length === 0) return null
  return (
    <div className="enc-group">
      <div className="enc-group-head">{label}</div>
      {entries.map((e) => (
        <EntryCard key={e.id} entry={e} />
      ))}
    </div>
  )
}

/** Apply the free-text search within an already item-filtered group, or pass it through unfiltered. */
function bySearch(entries: readonly EncyclopediaEntry[], q: string): readonly EncyclopediaEntry[] {
  if (!q) return entries
  return entries.filter(
    (e) => e.name.toLowerCase().includes(q) || e.machineName.toLowerCase().includes(q),
  )
}

/**
 * The recipe encyclopedia: a floating "Recipes" button (also on the `E` key) that opens a
 * searchable modal listing every recipe — its machine, ingredients, products and craft time —
 * built read-only from the loaded prototypes. Search matches a recipe/product or machine name.
 *
 * Clicking a resource swatch/label elsewhere in the UI (the treasury bar, the inspector's
 * accepts/produces rows, a recipe's ingredients) calls {@link encyclopediaStore.openForItem},
 * which narrows this panel to just the recipes that produce OR consume that item, labelled as two
 * groups — the "click through to the encyclopedia" path (Q4).
 */
export function Encyclopedia(): React.JSX.Element {
  const { entries, open, itemFilter } = useSyncExternalStore(
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
  const shown = useMemo(() => bySearch(entries, q), [q, entries])
  const filtered = useMemo(
    () => (itemFilter !== null ? filterEncyclopediaByItem(entries, itemFilter) : null),
    [entries, itemFilter],
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
          {itemFilter !== null && (
            <div className="enc-filter-chip">
              <span>Filtered on</span>
              <ResourceLabel color={itemFilter} size={14} />
              {priceForColor(itemFilter) !== undefined && (
                <span className="enc-price" title="Depot sale price">
                  · sells for {priceForColor(itemFilter)}¢
                </span>
              )}
              <button
                className="enc-filter-clear"
                onClick={() => encyclopediaStore.clearItemFilter()}
                title="Show all recipes"
                aria-label="Clear item filter"
              >
                ×
              </button>
            </div>
          )}
          <div className="enc-list">
            {filtered ? (
              <>
                <EntryGroup label="Produces" entries={bySearch(filtered.produces, q)} />
                <EntryGroup label="Consumes" entries={bySearch(filtered.consumes, q)} />
                {bySearch(filtered.produces, q).length === 0 &&
                  bySearch(filtered.consumes, q).length === 0 && (
                    <div className="enc-empty">No matching recipes.</div>
                  )}
              </>
            ) : (
              <>
                {shown.length === 0 && <div className="enc-empty">No matching recipes.</div>}
                {shown.map((e) => (
                  <EntryCard key={e.id} entry={e} />
                ))}
              </>
            )}
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
