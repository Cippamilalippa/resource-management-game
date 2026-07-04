import { describe, it, expect } from 'vitest'
import { hashState, hashSnapshot } from '@factory/engine/persistence'
import { bootstrapSim, type Sim } from '../bootstrap.ts'
import {
  enqueuePlaceProducer,
  enqueuePlaceBelt,
  enqueuePlacePort,
  enqueuePlaceBuilding,
  enqueuePlaceCannon,
  enqueueSetCannonTarget,
  enqueueSetCannonEnabled,
  serializeGameState,
  buildingAt,
  MAX_SLOTS,
  CANNON_RANGE,
} from '../gameLogic.ts'

/**
 * Cargo cannons: expensive long-haul artillery that flings a resource payload across the map into a
 * linked *silo* (the "not-a-train" freight system). Rules under test (per the design): a cannon
 * fires only when it is enabled, has a linked silo, the silo is in range and EMPTY, and the target
 * is a real silo (never a generic store). All build on an EMPTY world so the hashes are exact.
 */
const P = 0x22cc88 // the payload resource colour

interface Opts {
  /** Place the silo this many tiles east of the cannon (default 27, in range). */
  siloDist?: number
  /** Mark the receiver as a real silo (default true); false = a generic store (invalid target). */
  silo?: boolean
  /** Explicitly link the cannon to the silo (default true). */
  link?: boolean
  /** Leave auto-fire on (default true). */
  enabled?: boolean
  /** Place the cannon BEFORE the silo (default) or after (exercises placement auto-link). */
  cannonFirst?: boolean
}

/**
 * A producer feeding a cannon via a short belt, and a receiver `siloDist` tiles east with NO belt
 * between them — reachable only by shell. Nothing is ticked here, so every placement + the link land
 * in one command batch.
 */
async function boot(seed: number, o: Opts = {}): Promise<Sim> {
  const { siloDist = 27, silo = true, link = true, enabled = true, cannonFirst = true } = o
  const sim = await bootstrapSim(seed, { startScene: false })
  const w = sim.world
  const siloX = 3 + siloDist
  const placeSilo = (): void => {
    enqueuePlaceBuilding(w, {
      x: siloX,
      y: 0,
      w: 1,
      h: 1,
      color: 0x556677,
      accepts: [{ color: P, cap: 1000 }],
      silo,
    })
  }
  const placeCannon = (): void => {
    // Raw producer of P at (0,0) belted into an input port feeding the cannon at (3,0).
    enqueuePlaceProducer(w, {
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      color: 0x223344,
      itemColor: P,
      produceEvery: 3,
      storageCap: 1000,
    })
    enqueuePlaceBelt(w, { ax: 1, ay: 0, bx: 2, by: 0, color: 0x404040, moveEvery: 1 })
    enqueuePlacePort(w, { x: 1, y: 0, port: 'output', color: 0x44dd44, spawnEvery: 1 })
    enqueuePlacePort(w, { x: 2, y: 0, port: 'input', color: 0xdd4444 })
    enqueuePlaceCannon(w, { x: 3, y: 0, w: 1, h: 1, color: 0x8899aa, itemColor: P, payload: 3 })
  }
  // Order matters for the auto-link QoL: it only links to silos that already exist when the cannon
  // is placed. `cannonFirst` (the default) keeps auto-link from firing so the explicit-link tests
  // isolate `set_cannon_target`.
  if (cannonFirst) {
    placeCannon()
    placeSilo()
  } else {
    placeSilo()
    placeCannon()
  }
  if (link) enqueueSetCannonTarget(w, { x: 3, y: 0, tx: siloX, ty: 0 })
  if (!enabled) enqueueSetCannonEnabled(w, { x: 3, y: 0, enabled: false })
  return sim
}

/** Units of `color` currently stocked in the building at (x, y). */
function stock(sim: Sim, x: number, y: number, color: number): number {
  const b = buildingAt(sim.state.buildings, x, y)
  if (b < 0) return 0
  const bs = sim.state.buildings
  for (let k = 0; k < bs.slotN[b]!; k++) {
    const i = b * MAX_SLOTS + k
    if (bs.slotColor[i] === color) return bs.slotCount[i]!
  }
  return 0
}

describe('cargo cannon', () => {
  it('delivers a payload to a linked silo across open ground (no belt between them)', async () => {
    const sim = await boot(7)
    sim.scheduler.runTicks(sim.world, 400)
    // Exactly one burst lands: the silo fills to a payload and then the cannon holds (it is no longer
    // empty, and nothing drains it). Proves both delivery and the empty-target gate at once.
    expect(stock(sim, 30, 0, P)).toBe(3)
  })

  it('holds fire until it has a target', async () => {
    const sim = await boot(7, { link: false })
    sim.scheduler.runTicks(sim.world, 400)
    expect(stock(sim, 30, 0, P)).toBe(0)
    // …and its own deposit buffer holds the (capped) payload it accumulated.
    expect(stock(sim, 3, 0, P)).toBeGreaterThan(0)
    expect(sim.state.shells.count).toBe(0)
  })

  it('will not target a generic store — only a silo', async () => {
    const sim = await boot(7, { silo: false })
    sim.scheduler.runTicks(sim.world, 400)
    // The link is rejected (not a silo), so the cannon never fires and the store stays empty.
    expect(stock(sim, 30, 0, P)).toBe(0)
  })

  it('holds fire beyond its range', async () => {
    const sim = await boot(7, { siloDist: CANNON_RANGE + 5, link: true })
    sim.scheduler.runTicks(sim.world, 500)
    // Linked, but the silo is out of range — the cannon holds fire.
    expect(stock(sim, 3 + CANNON_RANGE + 5, 0, P)).toBe(0)
  })

  it('can be switched off', async () => {
    const sim = await boot(7, { enabled: false })
    sim.scheduler.runTicks(sim.world, 400)
    expect(stock(sim, 30, 0, P)).toBe(0)
  })

  it('auto-links to an in-range silo placed before it', async () => {
    // No explicit link: the cannon should find the pre-existing silo on placement and fire at it.
    const sim = await boot(7, { cannonFirst: false, link: false })
    sim.scheduler.runTicks(sim.world, 400)
    expect(stock(sim, 30, 0, P)).toBe(3)
  })

  it('is deterministic: same seed + ticks → identical hash', async () => {
    const a = await boot(11)
    const b = await boot(11)
    a.scheduler.runTicks(a.world, 350)
    b.scheduler.runTicks(b.world, 350)
    expect(hashState(a.world, { base: serializeGameState(a.state) })).toBe(
      hashState(b.world, { base: serializeGameState(b.state) }),
    )
    expect(hashSnapshot(a.serialize())).toBe(hashSnapshot(b.serialize()))
  })
})
