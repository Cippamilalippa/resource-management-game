import { icons } from 'lucide-react'
import { toRoman, type IconName } from './Icon.tsx'
import type { BuildItem } from './buildStore.ts'

/**
 * Fallback icon per tool kind, used when a prototype doesn't name its own `icon`. Keeps
 * third-party mods looking sensible without forcing every prototype to pick a glyph. The
 * base mod sets `icon` explicitly (see `mods/base/prototypes/buildings.json`).
 */
const KIND_ICON: Record<BuildItem['kind'], IconName> = {
  belt: 'Road',
  producer: 'Factory',
  building: 'Warehouse',
  splitter: 'Split',
  port: 'ArrowRightLeft',
}

/** Icon shown for a whole category button on the bottom row, keyed by tool kind. */
export const GROUP_ICON: Record<string, IconName> = { ...KIND_ICON }

/** Narrow an arbitrary string to a real lucide icon name. */
function isIconName(s: string): s is IconName {
  return Object.prototype.hasOwnProperty.call(icons, s)
}

/** Default glyph for an item with no (or an unknown) `icon`, including the in/out port split. */
function defaultIcon(item: BuildItem): IconName {
  if (item.kind === 'port') return item.port === 'output' ? 'ArrowUpFromLine' : 'ArrowDownToLine'
  return KIND_ICON[item.kind]
}

/** Pull a `MkN` tier out of a name → Roman-numeral badge (`I`, `II`, …), or `''` if none. */
function tierBadge(name: string): string {
  const m = /\bMk\s*(\d+)/i.exec(name)
  return m ? toRoman(Number(m[1])) : ''
}

export interface ResolvedIcon {
  readonly name: IconName
  /** Roman-numeral corner badge (Mk tier), present only when the name carries one. */
  readonly badge?: string
}

/**
 * Resolve the icon (and optional Mk badge) for a placeable item: the prototype's own `icon`
 * when it names a valid glyph, otherwise a per-kind default. The badge is derived from a
 * `MkN` suffix in the item name, so `Conveyor Belt Mk3` renders Road + `III`.
 */
export function iconForItem(item: BuildItem): ResolvedIcon {
  const name = item.icon && isIconName(item.icon) ? item.icon : defaultIcon(item)
  const badge = tierBadge(item.name)
  return badge ? { name, badge } : { name }
}
