/**
 * The single source of truth for how a *resource* (a game item) is shown: its icon and its
 * colour, resolved from the loaded item prototypes. Throughout the sim a resource's identity is
 * its packed `color` — that's what rides belts and fills building slots — so this registry is
 * keyed by colour, letting any part of the UI or renderer resolve the matching icon + name from
 * a bare colour alone (a building's `accepts`, a crafter's output, a belt item's tint, …).
 *
 * Populate it once at boot from the prototypes ({@link setResources}); read it anywhere with
 * {@link resourceByColor}. Mirrors how buildings pair an `icon` with a `color` (see `buildIcons`).
 */
import type { IconName } from './Icon.tsx'
import { isIconName } from './buildIcons.ts'
import type { ClientPrototype } from './sim.ts'

/** Glyph shown for a resource whose prototype names no (or an unknown) `icon`. */
const DEFAULT_RESOURCE_ICON: IconName = 'Box'

export interface Resource {
  readonly id: string
  readonly name: string
  readonly icon: IconName
  /** Packed 0xRRGGBB identity colour — the value carried through the sim for this resource. */
  readonly color: number
}

let byColor: ReadonlyMap<number, Resource> = new Map()
let all: readonly Resource[] = []

/**
 * Build the colour→resource lookup from the loaded item prototypes and install it as the active
 * registry. Returns the resources in prototype order (the renderer uses this to rasterize an icon
 * texture per resource colour). Colours are authored unique per prototype, so the map is 1:1.
 */
export function setResources(prototypes: readonly ClientPrototype[]): readonly Resource[] {
  const list: Resource[] = []
  const map = new Map<number, Resource>()
  for (const p of prototypes) {
    if (p.type !== 'item') continue
    const color = (typeof p.color === 'number' ? p.color : 0xffffff) >>> 0
    const icon = typeof p.icon === 'string' && isIconName(p.icon) ? p.icon : DEFAULT_RESOURCE_ICON
    const name = typeof p.name === 'string' ? p.name : p.id
    const res: Resource = { id: p.id, name, icon, color }
    map.set(color, res)
    list.push(res)
  }
  byColor = map
  all = list
  return list
}

/** The resource (icon + name) a packed colour denotes, or `undefined` if no item claims it. */
export function resourceByColor(color: number): Resource | undefined {
  return byColor.get(color >>> 0)
}

/** Every loaded resource, in prototype order — used by the port-filter picker to list items. */
export function allResources(): readonly Resource[] {
  return all
}

// --- credit prices (G6) ------------------------------------------------------

let priceByColor: ReadonlyMap<number, number> = new Map()

/**
 * Install the colour→credit price table the host computed from the recipe DAG (the same table the
 * sim charges/credits with — see `ClientSim.prices`). Called once per session at boot, right after
 * {@link setResources}. Read-only UI reference for cost rows and "sells for" readouts.
 */
export function setResourcePrices(
  entries: readonly { readonly color: number; readonly price: number }[],
): void {
  const map = new Map<number, number>()
  for (const e of entries) map.set(e.color >>> 0, e.price)
  priceByColor = map
}

/** The credit price one unit of this colour sells for / costs, or `undefined` if unpriced. */
export function priceForColor(color: number): number | undefined {
  return priceByColor.get(color >>> 0)
}

/** The credit value of a `{ color, amount }` cost list (unpriced colours count 1, like the sim). */
export function creditValueOf(
  cost: readonly { readonly color: number; readonly amount: number }[],
): number {
  let total = 0
  for (const c of cost) total += c.amount * (priceForColor(c.color) ?? 1)
  return total
}
