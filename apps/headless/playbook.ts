/**
 * An authored played-out scenario for the economy-KPI harness (roadmap M7). The KPI runner
 * ({@link ./kpi.ts}) only *samples* a running sim; a bare boot places no factory, so an un-driven
 * run reports the do-nothing baseline (the village declines, research never starts). This module is
 * the counterpart the roadmap calls for: a {@link SimDriver} that reads the freshly-booted scene and
 * hand-routes a real, belt-fed factory through the command bridge, so the sampled KPIs reflect a
 * played factory (research actually completes, raw flows down a chain) rather than an empty map.
 *
 * It is a pure host-side driver: it discovers deposits by reading `state.terrain` and issues
 * placement commands through the same {@link ./gameLogic.ts} bridge the build UI and the headless
 * tests use — it never mutates sim state directly, so the run stays deterministic (same seed +
 * scenario → the same commands → the same hash). See {@link ./tests/playbook.test.ts}.
 *
 * ## What it builds
 *
 * The first earnable technology is `tech.oil_refining` (30 `science_materials`); its prerequisite
 * `tech.industrial_foundry` is seeded free. `science_materials` unfolds to three raw ores:
 *
 *   bauxite → alumina ┐
 *   coal    → coke    ┴→ aluminum → aluminum_sheet ┐
 *   silica  →─────────── glass ───────────────────┴→ science_materials → lab
 *
 * So the playbook mines bauxite, coal and silica (a miner sits on each discovered deposit), refines
 * and smelts them down a compact processing block, and feeds the finished packs into a lab with the
 * active research set to `tech.oil_refining`. Placement through the command bridge is free (no
 * `cost`), exactly as every headless test drives it — the KPI harness measures the *economy* (flow,
 * bottlenecks, research/growth), not build affordability.
 *
 * ## Routing
 *
 * Belts move items building→building via an output port at the source end and an input port at the
 * dest end (see {@link layConveyor}). Miners must sit on their deposit terrain (scattered by seed), so
 * each raw is carried into a fixed processing block placed in clear space far from the deposits. The
 * block's internal links are straight, hand-laid runs (coke and glass lines share their consumer's
 * column, dropping/rising straight in), so they never congest. The three raw feeders — miner → raw
 * processor — are laid by a small BFS grid {@link Router} that routes each belt around everything
 * already placed. Routing succeeds for the large majority of layouts; a feeder that can't be wired is
 * simply skipped (the factory produces less), and the run is deterministic regardless — same seed →
 * same discovered tiles → same commands → same hash (the harness's non-negotiable guarantee).
 */
import type { GameWorld } from '@factory/engine/core'
import type { Sim } from './bootstrap.ts'
import {
  terrainTypeOf,
  terrainTypeAt,
  recipeTypeOf,
  techTypeOf,
  enqueuePlaceBelt,
  enqueuePlacePort,
  enqueuePlaceCrafter,
  enqueuePlaceBuilding,
  enqueueSetActiveResearch,
  type GameState,
} from './gameLogic.ts'

// --- Content constants (item colours + recipe cadences, mirrored from mods/base prototypes) -----
// These come straight from items.json / recipes.json. Kept as literals so the driver needs no
// registry lookups; validated indirectly by the liveness test (a wrong colour breaks the chain).
const C = {
  bauxite: 10506797,
  coal: 3026478,
  silica_sand: 14732916,
  alumina: 14275781,
  coke: 3815488,
  glass: 10478565,
  aluminum: 12634828,
  aluminum_sheet: 13556953,
  science_materials: 11583429,
} as const

/** Per-craft cadence (recipe `time`, speed 1) for each step of the science-materials chain. */
const CRAFT_EVERY = {
  bauxite: 40,
  coal: 35,
  silica_sand: 30,
  alumina: 40,
  coke: 30,
  glass: 40,
  aluminum: 60,
  aluminum_sheet: 40,
  science_materials: 50,
} as const

const STORAGE_CAP = 200
const BELT_MOVE_EVERY = 4
const DRAIN_EVERY = 4
/** A neutral footprint colour for authored buildings/belts (cosmetic only). */
const HUE = 0x556677

/** The first earnable technology and its authored pack cost (see technologies.json). */
const FIRST_TECH = techTypeOf('tech.oil_refining')
const FIRST_TECH_COST = [{ color: C.science_materials, amount: 30 }] as const

interface Tile {
  readonly x: number
  readonly y: number
}

// --- Deposit discovery ---------------------------------------------------------------------------

/**
 * Scan a bounded square of tiles for the first cell of terrain type `t`, in a fixed
 * (row-major) order so the pick is deterministic. Returns null if the type isn't present in range.
 * Scanning (rather than reverse-packing `tileKey`) keeps the driver off the engine's private
 * key layout and needs no exported unpacker.
 */
function findDeposit(state: GameState, t: number, radius: number): Tile | null {
  for (let y = -radius; y <= radius; y++) {
    for (let x = -radius; x <= radius; x++) {
      if (terrainTypeAt(state.terrain, x, y) === t) return { x, y }
    }
  }
  return null
}

// --- Belt / port placement helpers ---------------------------------------------------------------

/**
 * Lay an orthogonal belt through `waypoints` (each consecutive pair axis-aligned) and cap it with
 * an output port at the first tile (draining the building behind it) and an input port at the last
 * tile (feeding the building ahead of it). Items flow from `waypoints[0]` toward the last waypoint.
 *
 * Turn ownership: a corner tile must face its *outgoing* direction, else flow dead-ends into it. We
 * get that by laying each segment in full (`waypoints[i]`→`waypoints[i+1]`) in order: a shared corner
 * is first aimed by the incoming segment, then re-aimed by the outgoing one — leaving it facing out,
 * exactly as the belt system needs for an L-turn. (Laying partial runs instead risks a degenerate
 * single-tile segment whose direction — and thus the output port's facing — can't be inferred.)
 */
function layConveyor(w: GameWorld, waypoints: readonly Tile[]): void {
  const n = waypoints.length
  for (let i = 0; i < n - 1; i++) {
    const from = waypoints[i]!
    const to = waypoints[i + 1]!
    enqueuePlaceBelt(w, {
      ax: from.x,
      ay: from.y,
      bx: to.x,
      by: to.y,
      color: HUE,
      moveEvery: BELT_MOVE_EVERY,
    })
  }
  const head = waypoints[0]!
  const tail = waypoints[n - 1]!
  enqueuePlacePort(w, { x: head.x, y: head.y, port: 'output', color: HUE, spawnEvery: DRAIN_EVERY })
  enqueuePlacePort(w, { x: tail.x, y: tail.y, port: 'input', color: HUE })
}

/** Place a 1×1 recipe crafter (idle machine armed with its recipe) at `at`. */
function placeCrafter(
  w: GameWorld,
  at: Tile,
  recipe: string,
  inputs: readonly { color: number; amount: number }[],
  outputs: readonly { color: number; amount: number }[],
  craftEvery: number,
): void {
  enqueuePlaceCrafter(w, {
    x: at.x,
    y: at.y,
    w: 1,
    h: 1,
    color: HUE,
    recipe: recipeTypeOf(recipe),
    inputs: [...inputs],
    outputs: [...outputs],
    craftEvery,
    storageCap: STORAGE_CAP,
  })
}

/** Place an extraction miner on its deposit tile: no inputs, one raw unit per cadence. */
function placeMiner(
  w: GameWorld,
  at: Tile,
  recipe: string,
  raw: number,
  craftEvery: number,
  terrain: number,
): void {
  enqueuePlaceCrafter(w, {
    x: at.x,
    y: at.y,
    w: 1,
    h: 1,
    color: HUE,
    recipe: recipeTypeOf(recipe),
    inputs: [],
    outputs: [{ color: raw, amount: 1 }],
    craftEvery,
    storageCap: STORAGE_CAP,
    requiresTerrainType: terrain,
  })
}

// --- Grid router: BFS belt routing around occupied tiles -----------------------------------------

const DIRS: readonly { dx: number; dy: number }[] = [
  { dx: 0, dy: -1 },
  { dx: 1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 },
]

/** Collapse an adjacency tile path into its corner waypoints (drop collinear interior tiles). */
function corners(path: readonly Tile[]): Tile[] {
  if (path.length <= 2) return [...path]
  const out: Tile[] = [path[0]!]
  for (let i = 1; i < path.length - 1; i++) {
    const a = path[i - 1]!
    const b = path[i]!
    const c = path[i + 1]!
    if (
      Math.sign(b.x - a.x) !== Math.sign(c.x - b.x) ||
      Math.sign(b.y - a.y) !== Math.sign(c.y - b.y)
    ) {
      out.push(b)
    }
  }
  out.push(path[path.length - 1]!)
  return out
}

/**
 * A tile-grid belt router. Buildings mark their footprints occupied; each {@link connect} routes a
 * belt from one building to another around everything already placed (BFS shortest path), then marks
 * the new belt tiles occupied so later routes avoid them. This makes wiring layout-agnostic: it works
 * for any deposit scatter without hand-tuned lanes, and — being pure BFS over a fixed grid — is fully
 * deterministic (same occupancy → same path). Ports are attached so flow leaves the source and
 * enters the destination (see {@link layConveyor}).
 */
class Router {
  private readonly occ = new Set<number>()

  constructor(
    private readonly bounds: { minX: number; maxX: number; minY: number; maxY: number },
  ) {}

  private key(x: number, y: number): number {
    return (
      (x - this.bounds.minX) * (this.bounds.maxY - this.bounds.minY + 1) + (y - this.bounds.minY)
    )
  }

  private inBounds(x: number, y: number): boolean {
    return (
      x >= this.bounds.minX &&
      x <= this.bounds.maxX &&
      y >= this.bounds.minY &&
      y <= this.bounds.maxY
    )
  }

  private free(x: number, y: number): boolean {
    return this.inBounds(x, y) && !this.occ.has(this.key(x, y))
  }

  markRect(x: number, y: number, w: number, h: number): void {
    for (let dx = 0; dx < w; dx++)
      for (let dy = 0; dy < h; dy++) this.occ.add(this.key(x + dx, y + dy))
  }

  private mark(t: Tile): void {
    this.occ.add(this.key(t.x, t.y))
  }

  /** Lay a belt along a known (collision-free) polyline and mark all its tiles occupied. */
  wireFixed(w: GameWorld, waypoints: readonly Tile[]): void {
    layConveyor(w, waypoints)
    for (let i = 0; i < waypoints.length - 1; i++) {
      const a = waypoints[i]!
      const b = waypoints[i + 1]!
      const dx = Math.sign(b.x - a.x)
      const dy = Math.sign(b.y - a.y)
      let x = a.x
      let y = a.y
      this.mark({ x, y })
      while (x !== b.x || y !== b.y) {
        x += dx
        y += dy
        this.mark({ x, y })
      }
    }
  }

  /** BFS shortest tile path from `a` to `b` over free tiles (inclusive), or null if none exists. */
  private bfs(a: Tile, b: Tile): Tile[] | null {
    if (!this.free(a.x, a.y) || !this.free(b.x, b.y)) return null
    const prev = new Map<number, number>()
    const queue: Tile[] = [a]
    const seen = new Set<number>([this.key(a.x, a.y)])
    for (let head = 0; head < queue.length; head++) {
      const cur = queue[head]!
      if (cur.x === b.x && cur.y === b.y) {
        const path: Tile[] = []
        let k: number | undefined = this.key(cur.x, cur.y)
        let node = cur
        while (k !== undefined) {
          path.push(node)
          const pk: number | undefined = prev.get(k)
          if (pk === undefined) break
          node = {
            x: this.bounds.minX + Math.floor(pk / (this.bounds.maxY - this.bounds.minY + 1)),
            y: this.bounds.minY + (pk % (this.bounds.maxY - this.bounds.minY + 1)),
          }
          k = pk
        }
        return path.reverse()
      }
      for (const d of DIRS) {
        const nx = cur.x + d.dx
        const ny = cur.y + d.dy
        const nk = this.key(nx, ny)
        if (seen.has(nk) || !this.free(nx, ny)) continue
        seen.add(nk)
        prev.set(nk, this.key(cur.x, cur.y))
        queue.push({ x: nx, y: ny })
      }
    }
    return null
  }

  /** A free attach direction off building tile `at`: both the neighbour and the tile beyond it free. */
  private attach(at: Tile): { drain: Tile; probe: Tile } | null {
    for (const d of DIRS) {
      const drain = { x: at.x + d.dx, y: at.y + d.dy }
      const probe = { x: at.x + 2 * d.dx, y: at.y + 2 * d.dy }
      if (this.free(drain.x, drain.y) && this.free(probe.x, probe.y)) return { drain, probe }
    }
    return null
  }

  /**
   * Route and lay a belt from source building tile `src` to destination building tile `dst`. Returns
   * false if no free attach side or no path exists. The belt's output port drains `src` (it leaves
   * along a free side) and its input port feeds `dst` (it enters along a free side).
   */
  connect(w: GameWorld, src: Tile, dst: Tile): boolean {
    const s = this.attach(src)
    const d = this.attach(dst)
    if (!s || !d) return false
    // Reserve the two end tiles so the interior path can't reuse them, then route between the probes.
    this.mark(s.drain)
    this.mark(d.drain)
    const mid = this.bfs(s.probe, d.probe)
    if (!mid) return false
    const full = [s.drain, ...mid, d.drain]
    layConveyor(w, corners(full))
    for (const t of full) this.mark(t)
    return true
  }
}

// --- The authored factory ------------------------------------------------------------------------

/**
 * Drive `sim` to build the science-materials factory and select the first research. Reads the scene
 * (deposit tiles) and issues placement commands; safe to call once, right after boot and before the
 * KPI run. If a deposit type is missing from the scene the chain that needs it is skipped (the run
 * still boots and stays deterministic — it just produces less).
 */
export interface PlaybookResult {
  /** Deposits found in the scene (one miner placed per found type). */
  readonly minersPlaced: number
  /** How many raw feeders the router successfully wired (of `minersPlaced`). */
  readonly feedersWired: number
}

export function playFirstResearch(sim: Sim): PlaybookResult {
  const { world: w, state } = sim
  const radius = 40 // deposits sit within the scenario spread band around the origin

  const bauxite = findDeposit(state, terrainTypeOf('terrain.bauxite_deposit'), radius)
  const coal = findDeposit(state, terrainTypeOf('terrain.coal_seam'), radius)
  const silica = findDeposit(state, terrainTypeOf('terrain.silica_quarry'), radius)

  const BX = 200
  const R0 = 0

  // A compact processing block: the main line runs east along row R0 (alumina → aluminum → sheet →
  // science → lab); the coke line sits one band north and drops straight into the aluminum smelter,
  // the glass line one band south and rises straight into the science press. Every *internal* link is
  // therefore a straight belt, hand-laid (never congested). The router is used only for the three raw
  // feeders — miner → raw processor — so it never has to weave through the block.
  const RA = { x: BX, y: R0 } // refinery: 2 bauxite → 1 alumina
  const SA = { x: BX + 8, y: R0 } // smelter: 2 alumina + 1 coke → 1 aluminum
  const RM = { x: BX + 16, y: R0 } // rolling mill: 2 aluminum → 1 sheet
  const SP = { x: BX + 24, y: R0 } // science press: 1 sheet + 1 glass → 1 science_materials
  const LB = { x: BX + 32, y: R0 } // lab (2×2): consumes science packs
  const RC = { x: BX + 8, y: R0 - 8 } // refinery: 2 coal → 1 coke (drops into SA from the north)
  const SG = { x: BX + 24, y: R0 + 8 } // smelter: 2 silica → 1 glass (rises into SP from the south)

  const router = new Router({ minX: -70, maxX: 280, minY: -90, maxY: 90 })
  router.markRect(-1, -1, 2, 2) // the origin village
  router.markRect(49, 49, 8, 8) // the apple orchard (kept clear so belts route around it)
  for (const b of [RA, SA, RM, SP, RC, SG]) router.markRect(b.x, b.y, 1, 1)
  router.markRect(LB.x, LB.y, 2, 2)

  // Processing crafters (placed regardless; unfed ones simply never craft).
  placeCrafter(
    w,
    RA,
    'recipe.alumina',
    [{ color: C.bauxite, amount: 2 }],
    [{ color: C.alumina, amount: 1 }],
    CRAFT_EVERY.alumina,
  )
  placeCrafter(
    w,
    RC,
    'recipe.coke',
    [{ color: C.coal, amount: 2 }],
    [{ color: C.coke, amount: 1 }],
    CRAFT_EVERY.coke,
  )
  placeCrafter(
    w,
    SG,
    'recipe.glass',
    [{ color: C.silica_sand, amount: 2 }],
    [{ color: C.glass, amount: 1 }],
    CRAFT_EVERY.glass,
  )
  placeCrafter(
    w,
    SA,
    'recipe.aluminum',
    [
      { color: C.alumina, amount: 2 },
      { color: C.coke, amount: 1 },
    ],
    [{ color: C.aluminum, amount: 1 }],
    CRAFT_EVERY.aluminum,
  )
  placeCrafter(
    w,
    RM,
    'recipe.aluminum_sheet',
    [{ color: C.aluminum, amount: 2 }],
    [{ color: C.aluminum_sheet, amount: 1 }],
    CRAFT_EVERY.aluminum_sheet,
  )
  placeCrafter(
    w,
    SP,
    'recipe.science_materials',
    [
      { color: C.aluminum_sheet, amount: 1 },
      { color: C.glass, amount: 1 },
    ],
    [{ color: C.science_materials, amount: 1 }],
    CRAFT_EVERY.science_materials,
  )
  enqueuePlaceBuilding(w, {
    x: LB.x,
    y: LB.y,
    w: 2,
    h: 2,
    color: HUE,
    accepts: [{ color: C.science_materials, cap: 1000 }],
    researchLab: true,
  })

  // Miners sit on their deposits (mark them occupied so belts route around them).
  const feeders = [
    {
      dep: bauxite,
      recipe: 'recipe.bauxite',
      raw: C.bauxite,
      every: CRAFT_EVERY.bauxite,
      terrain: 'terrain.bauxite_deposit',
      to: RA,
    },
    {
      dep: coal,
      recipe: 'recipe.coal',
      raw: C.coal,
      every: CRAFT_EVERY.coal,
      terrain: 'terrain.coal_seam',
      to: RC,
    },
    {
      dep: silica,
      recipe: 'recipe.silica_sand',
      raw: C.silica_sand,
      every: CRAFT_EVERY.silica_sand,
      terrain: 'terrain.silica_quarry',
      to: SG,
    },
  ].filter((f): f is typeof f & { dep: Tile } => f.dep !== null)
  for (const f of feeders) {
    placeMiner(w, f.dep, f.recipe, f.raw, f.every, terrainTypeOf(f.terrain))
    router.markRect(f.dep.x, f.dep.y, 1, 1)
  }
  sim.scheduler.runTicks(w, 1) // apply every building so ports link to real buildings when belts land

  // Internal chain — straight, collision-free runs (marked so the feeders route around them).
  router.wireFixed(w, [
    { x: RA.x + 1, y: R0 },
    { x: SA.x - 1, y: R0 },
  ]) // alumina → aluminum smelter
  router.wireFixed(w, [
    { x: SA.x, y: RC.y + 1 },
    { x: SA.x, y: R0 - 1 },
  ]) // coke ↓ into aluminum smelter
  router.wireFixed(w, [
    { x: SA.x + 1, y: R0 },
    { x: RM.x - 1, y: R0 },
  ]) // aluminum → rolling mill
  router.wireFixed(w, [
    { x: RM.x + 1, y: R0 },
    { x: SP.x - 1, y: R0 },
  ]) // sheet → science press
  router.wireFixed(w, [
    { x: SP.x, y: SG.y - 1 },
    { x: SP.x, y: R0 + 1 },
  ]) // glass ↑ into science press
  router.wireFixed(w, [
    { x: SP.x + 1, y: R0 },
    { x: LB.x - 1, y: R0 },
  ]) // science packs → lab

  // Raw feeders — each miner → its processor, routed around everything already placed.
  let feedersWired = 0
  for (const f of feeders) if (router.connect(w, f.dep, f.to)) feedersWired++

  // Arm research: the lab drains packs into the first tech until its 30-pack cost is met.
  enqueueSetActiveResearch(w, { tech: FIRST_TECH, cost: [...FIRST_TECH_COST] })
  sim.scheduler.runTicks(w, 1)

  return { minersPlaced: feeders.length, feedersWired }
}
