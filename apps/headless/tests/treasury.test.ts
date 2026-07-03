import { describe, it, expect } from 'vitest'
import { hashSnapshot } from '@factory/engine/persistence'
import { bootstrapSim, type Sim } from '../bootstrap.ts'
import {
  buildingAt,
  createTreasuryStore,
  depositTreasury,
  treasuryAmount,
  canAffordTreasury,
  spendTreasury,
  refundTreasury,
  treasuryBalances,
  canAfford,
  enqueuePlaceBuilding,
  enqueuePlaceBelt,
  enqueuePlacePort,
  enqueuePlaceProducer,
  enqueueRemove,
} from '../gameLogic.ts'

/** An arbitrary resource colour used as a build-cost currency in the placement tests. */
const GOLD = 0xabcdef
/** A resource a producer makes, banked by the depot. */
const SRC = 0xf6d600

/** Hash the whole sim (engine entities + the base mod's serialized state, treasury included). */
function hashSim(sim: Sim): string {
  return hashSnapshot(sim.serialize())
}

describe('treasury store helpers', () => {
  it('deposits, sums by colour, and reports balances in insertion order', () => {
    const t = createTreasuryStore()
    depositTreasury(t, GOLD, 3)
    depositTreasury(t, SRC, 10)
    depositTreasury(t, GOLD, 2) // same colour accumulates
    expect(treasuryAmount(t, GOLD)).toBe(5)
    expect(treasuryAmount(t, SRC)).toBe(10)
    expect(treasuryAmount(t, 0x999)).toBe(0)
    expect(treasuryBalances({ treasury: t } as never)).toEqual([
      { color: GOLD, amount: 5 },
      { color: SRC, amount: 10 },
    ])
  })

  it('canAfford sums duplicate colour lines; spend deducts each line', () => {
    const t = createTreasuryStore()
    depositTreasury(t, GOLD, 5)
    expect(canAffordTreasury(t, [{ color: GOLD, amount: 3 }])).toBe(true)
    // Two lines of the same colour must be checked against their sum, not individually.
    expect(
      canAffordTreasury(t, [
        { color: GOLD, amount: 3 },
        { color: GOLD, amount: 3 },
      ]),
    ).toBe(false)
    spendTreasury(t, [{ color: GOLD, amount: 4 }])
    expect(treasuryAmount(t, GOLD)).toBe(1)
  })

  it('refund scales by the config permille', () => {
    const t = createTreasuryStore()
    refundTreasury(t, { buildRefundPermille: 1000 }, [{ color: GOLD, amount: 4 }])
    expect(treasuryAmount(t, GOLD)).toBe(4) // full
    refundTreasury(t, { buildRefundPermille: 500 }, [{ color: GOLD, amount: 5 }])
    expect(treasuryAmount(t, GOLD)).toBe(4 + 2) // floor(5 * 500 / 1000) = 2
    refundTreasury(t, { buildRefundPermille: 0 }, [{ color: GOLD, amount: 9 }])
    expect(treasuryAmount(t, GOLD)).toBe(6) // none
  })
})

describe('build cost charged from the treasury', () => {
  it('places and debits when affordable', async () => {
    const sim = await bootstrapSim(1)
    depositTreasury(sim.state.treasury, GOLD, 5)
    enqueuePlaceBuilding(sim.world, {
      x: 10,
      y: 10,
      w: 1,
      h: 1,
      color: 0x111111,
      accepts: [{ color: SRC, cap: 10 }],
      cost: [{ color: GOLD, amount: 3 }],
    })
    sim.scheduler.runTicks(sim.world, 1)
    expect(buildingAt(sim.state.buildings, 10, 10)).toBeGreaterThanOrEqual(0)
    expect(treasuryAmount(sim.state.treasury, GOLD)).toBe(2)
  })

  it('drops the placement and charges nothing when unaffordable', async () => {
    const sim = await bootstrapSim(1)
    depositTreasury(sim.state.treasury, GOLD, 2)
    expect(canAfford(sim.state, [{ color: GOLD, amount: 3 }])).toBe(false)
    enqueuePlaceBuilding(sim.world, {
      x: 10,
      y: 10,
      w: 1,
      h: 1,
      color: 0x111111,
      accepts: [{ color: SRC, cap: 10 }],
      cost: [{ color: GOLD, amount: 3 }],
    })
    sim.scheduler.runTicks(sim.world, 1)
    expect(buildingAt(sim.state.buildings, 10, 10)).toBeLessThan(0)
    expect(treasuryAmount(sim.state.treasury, GOLD)).toBe(2) // untouched
  })

  it('refunds the build cost on removal, scaled by the config permille', async () => {
    const sim = await bootstrapSim(1)
    depositTreasury(sim.state.treasury, GOLD, 5)
    enqueuePlaceBuilding(sim.world, {
      x: 10,
      y: 10,
      w: 1,
      h: 1,
      color: 0x111111,
      accepts: [{ color: SRC, cap: 10 }],
      cost: [{ color: GOLD, amount: 3 }],
    })
    sim.scheduler.runTicks(sim.world, 1)
    expect(treasuryAmount(sim.state.treasury, GOLD)).toBe(2)

    // Default config = full refund.
    enqueueRemove(sim.world, { x: 10, y: 10, refund: [{ color: GOLD, amount: 3 }] })
    sim.scheduler.runTicks(sim.world, 1)
    expect(buildingAt(sim.state.buildings, 10, 10)).toBeLessThan(0)
    expect(treasuryAmount(sim.state.treasury, GOLD)).toBe(5)
  })

  it('honours a half-refund config setting', async () => {
    const sim = await bootstrapSim(1)
    sim.state.config.buildRefundPermille = 500
    depositTreasury(sim.state.treasury, GOLD, 4)
    enqueuePlaceBuilding(sim.world, {
      x: 12,
      y: 12,
      w: 1,
      h: 1,
      color: 0x111111,
      accepts: [{ color: SRC, cap: 10 }],
      cost: [{ color: GOLD, amount: 4 }],
    })
    sim.scheduler.runTicks(sim.world, 1)
    expect(treasuryAmount(sim.state.treasury, GOLD)).toBe(0)
    enqueueRemove(sim.world, { x: 12, y: 12, refund: [{ color: GOLD, amount: 4 }] })
    sim.scheduler.runTicks(sim.world, 1)
    expect(treasuryAmount(sim.state.treasury, GOLD)).toBe(2) // floor(4 * 500 / 1000)
  })

  it('does not refund a no-op removal (empty tile)', async () => {
    const sim = await bootstrapSim(1)
    depositTreasury(sim.state.treasury, GOLD, 1)
    enqueueRemove(sim.world, { x: 200, y: 200, refund: [{ color: GOLD, amount: 3 }] })
    sim.scheduler.runTicks(sim.world, 1)
    expect(treasuryAmount(sim.state.treasury, GOLD)).toBe(1) // nothing removed → nothing refunded
  })
})

/** Lay a producer → belt → input-port → depot chain at y=30, so belted goods reach the depot. */
function bootDepotChain(sim: Sim): void {
  const w = sim.world
  enqueuePlaceProducer(w, {
    x: 20,
    y: 30,
    w: 1,
    h: 1,
    color: 0x223344,
    itemColor: SRC,
    produceEvery: 1,
    storageCap: 100,
  })
  enqueuePlaceBelt(w, { ax: 21, ay: 30, bx: 24, by: 30, color: 0x404040, moveEvery: 1 })
  enqueuePlacePort(w, { x: 21, y: 30, port: 'output', color: 0x44dd44, spawnEvery: 1 })
  enqueuePlacePort(w, { x: 24, y: 30, port: 'input', color: 0xdd4444 })
  // The depot sits east of the input port; belted SRC banks straight into the treasury.
  enqueuePlaceBuilding(w, { x: 25, y: 30, w: 1, h: 1, color: 0xccaa00, depot: true })
}

describe('depot refills the treasury', () => {
  it('banks belted goods into the treasury by colour', async () => {
    const sim = await bootstrapSim(1)
    bootDepotChain(sim)
    expect(treasuryAmount(sim.state.treasury, SRC)).toBe(0)
    sim.scheduler.runTicks(sim.world, 40)
    expect(treasuryAmount(sim.state.treasury, SRC)).toBeGreaterThan(0)
  })
})

describe('treasury determinism + persistence', () => {
  it('same seed + treasury activity → identical hash', async () => {
    const run = async (): Promise<string> => {
      const sim = await bootstrapSim(7)
      depositTreasury(sim.state.treasury, GOLD, 20)
      enqueuePlaceBuilding(sim.world, {
        x: 10,
        y: 10,
        w: 1,
        h: 1,
        color: 0x111111,
        accepts: [{ color: SRC, cap: 10 }],
        cost: [{ color: GOLD, amount: 3 }],
      })
      bootDepotChain(sim)
      sim.scheduler.runTicks(sim.world, 50)
      return hashSim(sim)
    }
    expect(await run()).toBe(await run())
  })

  it('round-trips through save/load with the treasury intact', async () => {
    const source = await bootstrapSim(3)
    depositTreasury(source.state.treasury, GOLD, 15)
    bootDepotChain(source)
    source.scheduler.runTicks(source.world, 45)
    const banked = treasuryAmount(source.state.treasury, SRC)
    expect(banked).toBeGreaterThan(0)

    const snapshot = source.serialize()
    const before = hashSim(source)

    const loaded = await bootstrapSim(3, { startScene: false })
    loaded.restore(snapshot)
    expect(hashSim(loaded)).toBe(before)
    expect(treasuryAmount(loaded.state.treasury, GOLD)).toBe(
      treasuryAmount(source.state.treasury, GOLD),
    )
    expect(treasuryAmount(loaded.state.treasury, SRC)).toBe(banked)
  })
})
