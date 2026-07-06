/**
 * Read-only builder for the detail overlay ("alt-mode") annotation set. Given the live building
 * store, belt grid and the host machine catalogue, it produces one {@link DetailMark} per object the
 * overlay annotates — a crafter's product glyph (or a warn marker when it has no recipe yet) and a
 * port's colour-filter chips. It reads sim state only (never mutates it), so it cannot affect
 * determinism, and is called only on the throttled HUD refresh — the per-object linear scan is fine
 * there (it never runs on the per-frame hot path).
 */
import type { DetailMark } from '@factory/engine/render'
import {
  KIND_OUTPUT,
  KIND_INPUT,
  MAX_PORT_FILTER,
  FILTER_EMPTY,
  FILTER_NONE,
  type BeltGrid,
  type BuildingStore,
} from './gameLogic.ts'
import type { MachineIndex } from './machines.ts'

/** Amber alert colour stamped on a crafter that has no recipe assigned yet (needs configuring). */
const WARN_COLOR = 0xffb300

/**
 * Collect the alt-mode annotations for the whole factory:
 * - every crafter → its recipe product colour (drawn as that item's glyph), or a warn marker when
 *   it is unconfigured (recipe 0);
 * - every input/output port with an active colour filter → its filtered colours as chips.
 */
export function collectDetailMarks(
  buildings: BuildingStore,
  grid: BeltGrid,
  machines: MachineIndex,
): DetailMark[] {
  const marks: DetailMark[] = []

  for (let b = 0; b < buildings.count; b++) {
    if (!buildings.crafts[b]) continue
    const x = buildings.bx[b]!
    const y = buildings.by[b]!
    const w = buildings.bw[b]!
    const h = buildings.bh[b]!
    const recipeInt = buildings.recipe[b]!
    if (recipeInt === 0) {
      marks.push({ x, y, w, h, warn: WARN_COLOR })
      continue
    }
    const recipe = machines.recipeByInt.get(recipeInt)
    // Draw the product glyph (resolved by the renderer through its icon-texture map). An unknown
    // recipe int (shouldn't happen for loaded content) is simply left unannotated.
    if (recipe) marks.push({ x, y, w, h, iconColor: recipe.outputColor })
  }

  for (let t = 0; t < grid.count; t++) {
    const kind = grid.kind[t]!
    if (kind !== KIND_OUTPUT && kind !== KIND_INPUT) continue
    if (grid.filterMode[t] === FILTER_NONE) continue
    const chips: number[] = []
    for (let j = 0; j < MAX_PORT_FILTER; j++) {
      const c = grid.filterColor[t * MAX_PORT_FILTER + j]!
      if (c !== FILTER_EMPTY) chips.push(c)
    }
    if (chips.length > 0) marks.push({ x: grid.tx[t]!, y: grid.ty[t]!, w: 1, h: 1, chips })
  }

  return marks
}
