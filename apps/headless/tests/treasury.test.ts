import { describe, it, expect } from 'vitest'
import { hashSnapshot } from '@factory/engine/persistence'
import { bootstrapSim, type Sim } from '../bootstrap.ts'
import {
  buildingAt,
  createTreasuryStore,
  createPriceTable,
  loadPriceTable,
  loadTreasurySnapshot,
  serializeTreasury,
  priceOf,
  costCredits,
  creditTreasury,
  treasuryCredits,
  canAffordTreasury,
  spendTreasury,
  refundTreasury,
  canAfford,
  registerBuilding,
  UPKEEP_CADENCE,
  DEFAULT_PRICE,
  enqueuePlaceBuilding,
  enqueuePlaceBelt,
  enqueuePlacePort,
  enqueuePlaceProducer,
  enqueueRemove,
  type GameStateSnapshot,
} from '../gameLogic.ts'

/** An arbitrary resource colour used as a build-cost line in the placement tests (no real item
 * claims it, so the sim prices it at {@link DEFAULT_PRICE} = 1 credit per unit). */
const GOLD = 0xabcdef
/** A synthetic resource a producer makes, sold by the depot (also priced at 1). */
const SRC = 0xf6d600
/** The real base-game aluminum colour (items.json) — priced from the recipe DAG. */
const ALUMINUM = 12634828
/** The real base-game glass colour (items.json). */
const GLASS = 10478565

/** Hash the whole sim (engine entities + the base mod's serialized state, treasury included). */
function hashSim(sim: Sim): string {
  return hashSnapshot(sim.serialize())
}

describe('price table', () => {
  it('prices an unknown colour at the default and a loaded colour at its entry', () => {
    const prices = createPriceTable()
    expect(priceOf(prices, GOLD)).toBe(DEFAULT_PRICE)
    loadPriceTable(prices, [{ color: GOLD, price: 7 }])
    expect(priceOf(prices, GOLD)).toBe(7)
    expect(priceOf(prices, SRC)).toBe(DEFAULT_PRICE)
    // Reloading replaces the whole table; a non-positive price clamps up to 1.
    loadPriceTable(prices, [{ color: SRC, price: 0 }])
    expect(priceOf(prices, GOLD)).toBe(DEFAULT_PRICE)
    expect(priceOf(prices, SRC)).toBe(1)
  })

  it('the bootstrapped sim carries recipe-DAG prices for the real items', async () => {
    // Hand-checked (laborWeight 0.5, tickRate 60): glass = ceil(2 + 0.5·1.667) = 3,
    // aluminum = ceil(6 + 0.5·6.667) = 10.
    const sim = await bootstrapSim(1)
    expect(priceOf(sim.state.prices, GLASS)).toBe(3)
    expect(priceOf(sim.state.prices, ALUMINUM)).toBe(10)
  })
})

describe('credit treasury helpers', () => {
  it('credits accumulate; costs are valued as Σ amount × price', () => {
    const t = createTreasuryStore()
    const prices = createPriceTable()
    loadPriceTable(prices, [{ color: GOLD, price: 5 }])
    creditTreasury(t, 12)
    creditTreasury(t, 3)
    creditTreasury(t, -99) // ignored — the balance never goes down through a credit
    expect(treasuryCredits(t)).toBe(15)
    expect(
      costCredits(prices, [
        { color: GOLD, amount: 2 }, // 2 × 5
        { color: SRC, amount: 4 }, // 4 × 1 (unpriced default)
      ]),
    ).toBe(14)
  })

  it('canAfford checks the credit value; spend deducts it (clamped at 0)', () => {
    const t = createTreasuryStore()
    const prices = createPriceTable()
    creditTreasury(t, 5)
    expect(canAffordTreasury(t, prices, [{ color: GOLD, amount: 5 }])).toBe(true)
    expect(canAffordTreasury(t, prices, [{ color: GOLD, amount: 6 }])).toBe(false)
    // Duplicate colour lines sum into one requirement.
    expect(
      canAffordTreasury(t, prices, [
        { color: GOLD, amount: 3 },
        { color: GOLD, amount: 3 },
      ]),
    ).toBe(false)
    spendTreasury(t, prices, [{ color: GOLD, amount: 4 }])
    expect(treasuryCredits(t)).toBe(1)
  })

  it('refund scales the credit value by the config permille', () => {
    const t = createTreasuryStore()
    const prices = createPriceTable()
    refundTreasury(t, { buildRefundPermille: 1000 }, prices, [{ color: GOLD, amount: 4 }])
    expect(treasuryCredits(t)).toBe(4) // full
    refundTreasury(t, { buildRefundPermille: 500 }, prices, [{ color: GOLD, amount: 5 }])
    expect(treasuryCredits(t)).toBe(4 + 2) // floor(5 × 500 / 1000)
    refundTreasury(t, { buildRefundPermille: 0 }, prices, [{ color: GOLD, amount: 9 }])
    expect(treasuryCredits(t)).toBe(6) // none
  })
})

describe('build cost charged from the treasury (in credits)', () => {
  it('places and debits when affordable', async () => {
    const sim = await bootstrapSim(1)
    sim.state.treasury.credits = 0
    creditTreasury(sim.state.treasury, 5)
    enqueuePlaceBuilding(sim.world, {
      x: 10,
      y: 10,
      w: 1,
      h: 1,
      color: 0x111111,
      accepts: [{ color: SRC, cap: 10 }],
      cost: [{ color: GOLD, amount: 3 }], // GOLD is unpriced → 3 credits
    })
    sim.scheduler.runTicks(sim.world, 1)
    expect(buildingAt(sim.state.buildings, 10, 10)).toBeGreaterThanOrEqual(0)
    expect(treasuryCredits(sim.state.treasury)).toBe(2)
  })

  it('drops the placement and charges nothing when unaffordable', async () => {
    const sim = await bootstrapSim(1)
    sim.state.treasury.credits = 0
    creditTreasury(sim.state.treasury, 2)
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
    expect(treasuryCredits(sim.state.treasury)).toBe(2) // untouched
  })

  it('charges a real-item cost at its recipe-DAG price', async () => {
    const sim = await bootstrapSim(1)
    sim.state.treasury.credits = 25
    enqueuePlaceBuilding(sim.world, {
      x: 10,
      y: 10,
      w: 1,
      h: 1,
      color: 0x111111,
      accepts: [{ color: SRC, cap: 10 }],
      cost: [
        { color: ALUMINUM, amount: 2 }, // 2 × 10¢
        { color: GLASS, amount: 1 }, // 1 × 3¢
      ],
    })
    sim.scheduler.runTicks(sim.world, 1)
    expect(buildingAt(sim.state.buildings, 10, 10)).toBeGreaterThanOrEqual(0)
    expect(treasuryCredits(sim.state.treasury)).toBe(25 - 23)
  })

  it('refunds the build cost on removal, scaled by the config permille', async () => {
    const sim = await bootstrapSim(1)
    sim.state.treasury.credits = 0
    creditTreasury(sim.state.treasury, 5)
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
    expect(treasuryCredits(sim.state.treasury)).toBe(2)

    // Default config = full refund.
    enqueueRemove(sim.world, { x: 10, y: 10, refund: [{ color: GOLD, amount: 3 }] })
    sim.scheduler.runTicks(sim.world, 1)
    expect(buildingAt(sim.state.buildings, 10, 10)).toBeLessThan(0)
    expect(treasuryCredits(sim.state.treasury)).toBe(5)
  })

  it('honours a half-refund config setting', async () => {
    const sim = await bootstrapSim(1)
    sim.state.config.buildRefundPermille = 500
    sim.state.treasury.credits = 0
    creditTreasury(sim.state.treasury, 4)
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
    expect(treasuryCredits(sim.state.treasury)).toBe(0)
    enqueueRemove(sim.world, { x: 12, y: 12, refund: [{ color: GOLD, amount: 4 }] })
    sim.scheduler.runTicks(sim.world, 1)
    expect(treasuryCredits(sim.state.treasury)).toBe(2) // floor(4 × 500 / 1000)
  })

  it('does not refund a no-op removal (empty tile)', async () => {
    const sim = await bootstrapSim(1)
    sim.state.treasury.credits = 0
    creditTreasury(sim.state.treasury, 1)
    enqueueRemove(sim.world, { x: 200, y: 200, refund: [{ color: GOLD, amount: 3 }] })
    sim.scheduler.runTicks(sim.world, 1)
    expect(treasuryCredits(sim.state.treasury)).toBe(1) // nothing removed → nothing refunded
  })
})

/** Lay a producer → belt → input-port → depot chain at y=30, so belted goods reach the depot. */
function bootDepotChain(sim: Sim, itemColor = SRC): void {
  const w = sim.world
  enqueuePlaceProducer(w, {
    x: 20,
    y: 30,
    w: 1,
    h: 1,
    color: 0x223344,
    itemColor,
    produceEvery: 1,
    storageCap: 100,
  })
  enqueuePlaceBelt(w, { ax: 21, ay: 30, bx: 24, by: 30, color: 0x404040, moveEvery: 1 })
  enqueuePlacePort(w, { x: 21, y: 30, port: 'output', color: 0x44dd44, spawnEvery: 1 })
  enqueuePlacePort(w, { x: 24, y: 30, port: 'input', color: 0xdd4444 })
  // The depot sits east of the input port; belted goods sell straight into the credit balance.
  enqueuePlaceBuilding(w, { x: 25, y: 30, w: 1, h: 1, color: 0xccaa00, depot: true })
}

describe('depot sells into the treasury at the item price', () => {
  it('credits an unpriced colour at 1 per unit', async () => {
    const sim = await bootstrapSim(1)
    sim.state.treasury.credits = 0
    bootDepotChain(sim)
    sim.scheduler.runTicks(sim.world, 40)
    expect(treasuryCredits(sim.state.treasury)).toBeGreaterThan(0)
  })

  it('credits a real item at its market price (aluminum = 10¢ per unit)', async () => {
    const sim = await bootstrapSim(1)
    sim.state.treasury.credits = 0
    bootDepotChain(sim, ALUMINUM)
    sim.scheduler.runTicks(sim.world, 40)
    const credits = treasuryCredits(sim.state.treasury)
    expect(credits).toBeGreaterThan(0)
    expect(credits % 10).toBe(0) // every sale banked exactly one aluminum price
  })
})

describe('upkeep sink', () => {
  it('drains each building type upkeep once per cadence, flooring at zero', async () => {
    const sim = await bootstrapSim(1)
    sim.state.treasury.credits = 0
    creditTreasury(sim.state.treasury, 10)
    // Register two standing buildings with upkeep 3 and 4 directly (off the command path).
    registerBuilding(sim.state.buildings, -1, 60, 60, 1, 1, 0, 1, [], 0, 0, 3)
    registerBuilding(sim.state.buildings, -1, 62, 60, 1, 1, 0, 1, [], 0, 0, 4)
    // One full cadence drains 3 + 4 = 7.
    sim.scheduler.runTicks(sim.world, UPKEEP_CADENCE)
    expect(treasuryCredits(sim.state.treasury)).toBe(3)
    // The next cadence would owe 7 again but only 3 remain: the balance floors at 0 (no debt).
    sim.scheduler.runTicks(sim.world, UPKEEP_CADENCE)
    expect(treasuryCredits(sim.state.treasury)).toBe(0)
    // Nothing breaks at zero — buildings stand, the drain just keeps flooring.
    sim.scheduler.runTicks(sim.world, UPKEEP_CADENCE)
    expect(treasuryCredits(sim.state.treasury)).toBe(0)
  })

  it('is deterministic: same seed + upkeep activity → identical hash', async () => {
    const run = async (): Promise<string> => {
      const sim = await bootstrapSim(11)
      creditTreasury(sim.state.treasury, 500)
      registerBuilding(sim.state.buildings, -1, 60, 60, 1, 1, 0, 1, [], 0, 0, 5)
      bootDepotChain(sim)
      sim.scheduler.runTicks(sim.world, UPKEEP_CADENCE + 50)
      return hashSim(sim)
    }
    expect(await run()).toBe(await run())
  })
})

describe('treasury determinism + persistence', () => {
  it('same seed + treasury activity → identical hash', async () => {
    const run = async (): Promise<string> => {
      const sim = await bootstrapSim(7)
      creditTreasury(sim.state.treasury, 20)
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

  it('round-trips through save/load with the credit balance and upkeep timer intact', async () => {
    const source = await bootstrapSim(3)
    const seeded = treasuryCredits(source.state.treasury) // the scenario's starting balance
    creditTreasury(source.state.treasury, 15)
    bootDepotChain(source)
    source.scheduler.runTicks(source.world, 45)
    const credits = treasuryCredits(source.state.treasury)
    expect(credits).toBeGreaterThan(seeded) // depot sales landed on top of the seed

    const snapshot = source.serialize()
    const before = hashSim(source)

    const loaded = await bootstrapSim(3, { startScene: false })
    loaded.restore(snapshot)
    expect(hashSim(loaded)).toBe(before)
    expect(treasuryCredits(loaded.state.treasury)).toBe(credits)
    expect(loaded.state.treasury.upkeepTimer).toBe(source.state.treasury.upkeepTimer)
  })

  it('serialize→load round-trips the treasury snapshot byte-identically', () => {
    const t = createTreasuryStore()
    const prices = createPriceTable()
    creditTreasury(t, 123)
    t.upkeepTimer = 456
    const snap = serializeTreasury(t)
    const back = createTreasuryStore()
    loadTreasurySnapshot(back, prices, snap)
    expect(back).toEqual(t)
    expect(serializeTreasury(back)).toEqual(snap)
  })

  it('converts a LEGACY per-colour bank by selling it at current prices', () => {
    // Legacy rule: credits = Σ amount × price(colour) — the exact conversion a depot sale applies.
    const t = createTreasuryStore()
    const prices = createPriceTable()
    loadPriceTable(prices, [{ color: ALUMINUM, price: 10 }])
    loadTreasurySnapshot(t, prices, {
      entries: [
        { color: ALUMINUM, amount: 9 }, // 90
        { color: GOLD, amount: 4 }, // 4 (unpriced default)
      ],
    })
    expect(treasuryCredits(t)).toBe(94)
    expect(t.upkeepTimer).toBe(0)
  })

  it('loads a legacy full-state snapshot (per-colour treasury) without crashing', async () => {
    // Build a current save, then rewrite its treasury blob to the pre-G6 per-colour shape.
    const source = await bootstrapSim(5)
    source.scheduler.runTicks(source.world, 10)
    const snapshot = source.serialize()
    const base = snapshot.modState.base as GameStateSnapshot
    const legacyBase = {
      ...base,
      treasury: { entries: [{ color: ALUMINUM, amount: 3 }] }, // pre-G6 shape: no `credits`
    } as GameStateSnapshot
    const legacy = { ...snapshot, modState: { ...snapshot.modState, base: legacyBase } }

    const loaded = await bootstrapSim(5, { startScene: false })
    loaded.restore(legacy)
    // 3 banked aluminum sell at the current recipe-DAG price (10¢) → 30 credits.
    expect(treasuryCredits(loaded.state.treasury)).toBe(30)
  })
})
