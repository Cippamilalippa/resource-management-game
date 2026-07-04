/**
 * A deterministic **stress map** for testing: it tiles many copies of a full production chain across
 * an empty world, wiring each with belts and ports, so the sim runs *thousands* of live entities —
 * producers, multi-stage crafters, belts with items in flight, and treasury depots draining the
 * output. It exercises the whole hot path (belt movement, crafting, port drain) at scale, and — being
 * built entirely through the same command bridge the build UI uses — stays fully deterministic (same
 * seed + parameters → the same commands → the same `stateHash`).
 *
 * It's a *test* artifact, not game content: the chain uses 1:1 flow and synthetic (but real-item)
 * colours purely to keep every cell identical and self-sustaining. Drive it with `pnpm stress`
 * ({@link ./stress-run.ts}) to measure per-tick cost / entity count, or snapshot it to a save file
 * to load and watch in the actual game. Covered by {@link ./tests/stressmap.test.ts}.
 */
import type { GameWorld } from '@factory/engine/core'
import type { Sim } from './bootstrap.ts'
import {
  enqueuePlaceBelt,
  enqueuePlacePort,
  enqueuePlaceCrafter,
  enqueuePlaceProducer,
  enqueuePlaceBuilding,
} from './gameLogic.ts'

/**
 * The chain's per-stage resource colours (raw → final), borrowed from real base items so a loaded
 * map renders proper icons. Flow is 1:1 (each stage turns one unit of the previous colour into one
 * of its own), so the whole chain self-sustains without balancing — all we want is steady activity.
 */
const CHAIN: readonly number[] = [
  10506797, // bauxite (raw — the producer emits this)
  14275781, // alumina
  12634828, // aluminum
  13556953, // aluminum_sheet
  10478565, // glass
  11583429, // science_materials (final — banked by the depot)
]

/** Neutral footprint colour for the machines/ports (cosmetic only). */
const HUE = 0x556677
/** Belt tint. */
const BELT_HUE = 0x404040

const STAGE_GAP = 3 // tiles between consecutive machines (leaves a 2-tile belt + its two ports)
const PRODUCE_EVERY = 12 // raw producer cadence (ticks)
const CRAFT_EVERY = 14 // per-stage craft cadence (ticks)
const BELT_MOVE_EVERY = 4 // belt item step cadence
const DRAIN_EVERY = 4 // output-port drain cadence
const STORAGE_CAP = 100

/** A cell spans the chain (machines + depot) plus a margin column so neighbours never touch. */
const CELL_W = CHAIN.length * STAGE_GAP + 3
/** Rows between cells (the chain is one row tall; the gap keeps belts/ports from adjoining). */
const CELL_H = 3

export interface StressMapResult {
  /** Number of production-chain cells laid. */
  readonly cells: number
  readonly cols: number
  readonly rows: number
}

/** Lay one production-chain cell with its top-left machine at (ox, oy). */
function buildCell(w: GameWorld, ox: number, oy: number): void {
  // Stage 0: a raw producer (no input) emitting the first chain colour.
  enqueuePlaceProducer(w, {
    x: ox,
    y: oy,
    w: 1,
    h: 1,
    color: HUE,
    itemColor: CHAIN[0]!,
    produceEvery: PRODUCE_EVERY,
    storageCap: STORAGE_CAP,
  })
  // Stages 1..n-1: each consumes the previous colour and makes its own (1:1).
  for (let s = 1; s < CHAIN.length; s++) {
    enqueuePlaceCrafter(w, {
      x: ox + s * STAGE_GAP,
      y: oy,
      w: 1,
      h: 1,
      color: HUE,
      recipe: 1,
      inputs: [{ color: CHAIN[s - 1]!, amount: 1 }],
      outputs: [{ color: CHAIN[s]!, amount: 1 }],
      craftEvery: CRAFT_EVERY,
      storageCap: STORAGE_CAP,
    })
  }
  // Terminal depot: a wildcard treasury sink, so the final good always drains (no backpressure).
  const depotX = ox + CHAIN.length * STAGE_GAP
  enqueuePlaceBuilding(w, { x: depotX, y: oy, w: 1, h: 1, color: HUE, depot: true })

  // Link every consecutive machine with a 2-tile belt: an output port drains the left machine at the
  // near tile, an input port feeds the right machine at the far tile. All straight, never congested.
  for (let s = 0; s < CHAIN.length; s++) {
    const ax = ox + s * STAGE_GAP + 1 // just right of the left machine
    const bx = ox + (s + 1) * STAGE_GAP - 1 // just left of the right machine
    enqueuePlaceBelt(w, { ax, ay: oy, bx, by: oy, color: BELT_HUE, moveEvery: BELT_MOVE_EVERY })
    enqueuePlacePort(w, { x: ax, y: oy, port: 'output', color: HUE, spawnEvery: DRAIN_EVERY })
    enqueuePlacePort(w, { x: bx, y: oy, port: 'input', color: HUE })
  }
}

/**
 * Build `cells` production-chain cells in a near-square grid on `sim`'s (empty) world, then apply the
 * placements with a single tick so ports link to their machines. Boot the sim with `startScene: false`
 * so the chains own the whole map. Returns the grid dimensions.
 */
export function buildStressMap(sim: Sim, cells: number): StressMapResult {
  const n = Math.max(1, Math.floor(cells))
  const cols = Math.ceil(Math.sqrt(n))
  const rows = Math.ceil(n / cols)
  const w = sim.world
  // Centre the whole grid on the origin so a freshly-loaded map sits under the default camera.
  const offX = -Math.floor((cols * CELL_W) / 2)
  const offY = -Math.floor((rows * CELL_H) / 2)
  let laid = 0
  for (let r = 0; r < rows && laid < n; r++) {
    for (let c = 0; c < cols && laid < n; c++) {
      buildCell(w, offX + c * CELL_W, offY + r * CELL_H)
      laid++
    }
  }
  sim.scheduler.runTicks(w, 1) // apply every placement; ports link to the now-present machines
  return { cells: laid, cols, rows }
}
