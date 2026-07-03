import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { buildStore, type BuildItem } from './buildStore.ts'
import { blueprintStore } from './blueprintStore.ts'
import { Icon } from './Icon.tsx'
import { GROUP_ICON, iconForItem } from './buildIcons.ts'
import { ResourceLabel } from './ResourceLabel.tsx'

/** Display labels for each tool kind; unknown kinds fall back to the raw kind string. */
const GROUP_LABEL: Record<string, string> = {
  belt: 'Belts',
  producer: 'Machines',
  building: 'Buildings',
  splitter: 'Splitters',
  port: 'Ports',
}

/** Singular label for a single item's kind in its detail panel. */
const KIND_LABEL: Record<string, string> = {
  belt: 'Belt',
  producer: 'Machine',
  building: 'Building',
  splitter: 'Splitter',
  port: 'Port',
}

/** Stable presentation order for the groups; unknown kinds sort last (in appearance order). */
const GROUP_ORDER: Record<string, number> = {
  belt: 0,
  producer: 1,
  building: 2,
  splitter: 3,
  port: 4,
}

interface Group {
  readonly key: string
  readonly label: string
  readonly items: readonly BuildItem[]
}

/** What the hover detail panel is currently describing, if anything. */
type Hover =
  | { readonly kind: 'item'; readonly item: BuildItem }
  | { readonly kind: 'group'; readonly group: Group }

/** Bucket the placeable items by kind into ordered groups for the first menu level. */
function groupItems(items: readonly BuildItem[]): Group[] {
  const byKey = new Map<string, BuildItem[]>()
  const order: string[] = []
  for (const item of items) {
    let bucket = byKey.get(item.kind)
    if (!bucket) {
      bucket = []
      byKey.set(item.kind, bucket)
      order.push(item.kind)
    }
    bucket.push(item)
  }
  const groups = order.map((key) => ({
    key,
    label: GROUP_LABEL[key] ?? key,
    items: byKey.get(key)!,
  }))
  // Array.sort is stable, so unknown kinds (order 99) keep their appearance order.
  groups.sort((a, b) => (GROUP_ORDER[a.key] ?? 99) - (GROUP_ORDER[b.key] ?? 99))
  return groups
}

/** Keyboard shortcut shown for slot index i: 1..9 then 0 for the tenth; blank past that. */
function shortcutLabel(i: number): string {
  return i < 9 ? String(i + 1) : i === 9 ? '0' : ''
}

/** Map a key event to a slot index (0-based), or -1 if it isn't a 1..9/0 digit. */
function slotForKey(key: string): number {
  if (key === '0') return 9
  if (key >= '1' && key <= '9') return key.charCodeAt(0) - '1'.charCodeAt(0)
  return -1
}

interface DetailRow {
  readonly label: string
  readonly value: string
  /** When set, render a colour swatch instead of the text value. */
  readonly swatches?: readonly number[]
}

/** The stat rows shown in the hover panel for a single placeable item. */
function itemRows(item: BuildItem): DetailRow[] {
  switch (item.kind) {
    case 'belt':
      return [{ label: 'Speed', value: `1 tile / ${item.moveEvery} ticks` }]
    case 'producer':
      // A machine is placed empty; its recipe (and thus I/O) is chosen afterward in the sidebar.
      return [
        { label: 'Storage', value: String(item.storage) },
        { label: 'Recipe', value: 'Choose after placing' },
      ]
    case 'building':
      return [
        ...(item.accepts.length > 0
          ? [{ label: 'Accepts', value: '', swatches: item.accepts }]
          : []),
        { label: 'Storage', value: String(item.storage) },
      ]
    case 'port':
      return item.port === 'output'
        ? [{ label: 'Drains', value: `1 / ${item.spawnEvery} ticks` }]
        : [{ label: 'Feeds', value: 'the attached belt' }]
    case 'splitter':
      return [{ label: 'Routes', value: 'evenly across outputs' }]
    default:
      return []
  }
}

/** The detail panel shown above the bar while hovering a tool or category. */
function DetailPanel({ hover }: { hover: Hover }): React.JSX.Element {
  if (hover.kind === 'group') {
    const { group } = hover
    return (
      <div className="buildbar-detail">
        <div className="buildbar-detail-head">
          <Icon name={GROUP_ICON[group.key] ?? 'Box'} size={22} />
          <div className="buildbar-detail-titles">
            <span className="buildbar-detail-title">{group.label}</span>
            <span className="buildbar-detail-sub">{group.items.length} items</span>
          </div>
        </div>
        <div className="buildbar-detail-rows">
          <span className="buildbar-detail-list">{group.items.map((i) => i.name).join(' · ')}</span>
        </div>
      </div>
    )
  }

  const { item } = hover
  const { name, badge } = iconForItem(item)
  return (
    <div className="buildbar-detail">
      <div className="buildbar-detail-head">
        <Icon name={name} badge={badge} size={22} />
        <div className="buildbar-detail-titles">
          <span className="buildbar-detail-title">{item.name}</span>
          <span className="buildbar-detail-sub">
            {KIND_LABEL[item.kind] ?? item.kind}
            {item.locked && ' · 🔒 Research to unlock'}
          </span>
        </div>
      </div>
      <div className="buildbar-detail-rows">
        {itemRows(item).map((row) => (
          <div key={row.label} className="buildbar-detail-row">
            <span className="buildbar-detail-label">{row.label}</span>
            {row.swatches ? (
              <span className="buildbar-detail-swatches">
                {row.swatches.map((c, i) => (
                  <ResourceLabel key={i} color={c} />
                ))}
              </span>
            ) : (
              <span className="buildbar-detail-value">{row.value}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Bottom toolbar of placeable things, organised as two stacked levels: the always-visible group
 * list (by kind) on the bottom row, and — once a group is opened — the items inside it on a second
 * row above. Each entry is an icon (via the {@link Icon} wrapper); hovering one raises a detail
 * panel above the bar. Both levels are reachable by the 1..9/0 number keys, with the shortcut
 * badged on each button. Selecting a tool arms placement (handled by `placement.ts`); clicking the
 * selected tool again disarms it. Reads the build store and owns only transient menu navigation
 * state; it never touches the sim.
 */
export function BuildBar(): React.JSX.Element | null {
  const state = useSyncExternalStore(buildStore.subscribe, buildStore.get, buildStore.get)
  const clip = useSyncExternalStore(
    blueprintStore.subscribe,
    blueprintStore.get,
    blueprintStore.get,
  )
  // Which group is expanded (its kind), or null while showing the top-level group list.
  const [openKey, setOpenKey] = useState<string | null>(null)
  // What the cursor is currently over, surfaced in the detail panel; null when not hovering.
  const [hover, setHover] = useState<Hover | null>(null)

  const groups = useMemo(() => groupItems(state.items), [state.items])
  const openGroup = openKey ? (groups.find((g) => g.key === openKey) ?? null) : null

  const goBack = (): void => {
    setOpenKey(null)
    buildStore.clearSelection()
  }

  // Open a group (showing its items above), or, if it's already open, close back to just the
  // group row. Switching groups clears any armed tool from the previous one.
  const openGroupKey = (key: string): void => {
    buildStore.clearSelection()
    setOpenKey((cur) => (cur === key ? null : key))
  }

  // Number keys drive both levels; Escape steps back out / disarms. Bound to the window so the
  // shortcuts work without the toolbar holding focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      if (e.key === 'Escape') {
        // A clipboard tool (copy-select / paste) takes priority — Esc clears the cursor, matching
        // Factorio (right-click also cancels). The naming/library overlays own their own Esc.
        if (blueprintStore.get().mode !== 'idle' && !blueprintStore.get().naming) {
          blueprintStore.cancel()
        } else if (openKey !== null) goBack()
        else buildStore.clearSelection()
        return
      }
      const slot = slotForKey(e.key)
      if (slot < 0) return
      if (openKey === null) {
        const group = groups[slot]
        if (group) setOpenKey(group.key)
      } else {
        const item = openGroup?.items[slot]
        if (item && !item.locked) buildStore.toggle(item.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [groups, openKey, openGroup])

  if (groups.length === 0) return null

  return (
    <div className="buildbar">
      {hover && <DetailPanel hover={hover} />}
      {openGroup && (
        <div className="buildbar-tools buildbar-items">
          {openGroup.items.map((item, i) => {
            const { name, badge } = iconForItem(item)
            return (
              <button
                key={item.id}
                className={`tool${state.selected === item.id ? ' selected' : ''}${item.locked ? ' locked' : ''}`}
                onClick={() => !item.locked && buildStore.toggle(item.id)}
                onMouseEnter={() => setHover({ kind: 'item', item })}
                onMouseLeave={() =>
                  setHover((h) => (h?.kind === 'item' && h.item === item ? null : h))
                }
                onFocus={() => setHover({ kind: 'item', item })}
                onBlur={() => setHover((h) => (h?.kind === 'item' && h.item === item ? null : h))}
                title={item.locked ? `${item.name} — locked (research to unlock)` : item.name}
                aria-label={item.name}
                aria-disabled={item.locked ? true : undefined}
              >
                <Icon name={name} badge={badge} size={22} />
                {item.locked && (
                  <span className="tool-lock">
                    <Icon name="Lock" size={11} />
                  </span>
                )}
                {shortcutLabel(i) && <span className="tool-key">{shortcutLabel(i)}</span>}
              </button>
            )
          })}
        </div>
      )}
      <div className="buildbar-tools buildbar-groups">
        {groups.map((group, i) => (
          <button
            key={group.key}
            className={`tool tool-group${openKey === group.key ? ' open' : ''}`}
            onClick={() => openGroupKey(group.key)}
            onMouseEnter={() => setHover({ kind: 'group', group })}
            onMouseLeave={() =>
              setHover((h) => (h?.kind === 'group' && h.group === group ? null : h))
            }
            onFocus={() => setHover({ kind: 'group', group })}
            onBlur={() => setHover((h) => (h?.kind === 'group' && h.group === group ? null : h))}
            title={group.label}
            aria-label={group.label}
          >
            <Icon name={GROUP_ICON[group.key] ?? 'Box'} size={22} />
            {shortcutLabel(i) && <span className="tool-key">{shortcutLabel(i)}</span>}
          </button>
        ))}
        <button
          className={`tool tool-delete${state.deleting ? ' selected' : ''}`}
          onClick={() => buildStore.toggleDelete()}
          title="Delete object"
          aria-label="Delete object"
          aria-pressed={state.deleting}
        >
          <Icon name="Trash2" size={22} />
        </button>
        <button
          className={`tool tool-copy${clip.mode !== 'idle' ? ' selected' : ''}`}
          onClick={() =>
            clip.mode === 'idle' ? blueprintStore.armCopy() : blueprintStore.cancel()
          }
          title="Copy area (drag to select, then click to paste) · Ctrl+C"
          aria-label="Copy area"
          aria-pressed={clip.mode !== 'idle'}
        >
          <Icon name="Copy" size={22} />
        </button>
        <button
          className="tool tool-blueprint"
          onClick={() => blueprintStore.toggleLibrary()}
          title="Blueprint library"
          aria-label="Blueprint library"
        >
          <Icon name="ClipboardList" size={22} />
        </button>
      </div>
    </div>
  )
}
