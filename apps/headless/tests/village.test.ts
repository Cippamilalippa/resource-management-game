import { describe, it, expect } from 'vitest'
import { hashState } from '@factory/engine/persistence'
import { bootstrapSim, type Sim } from '../bootstrap.ts'
import {
  MAX_SLOTS,
  buildingAt,
  villageStageAt,
  collectAlerts,
  serializeGameState,
  VILLAGE_DECLINE_GRACE,
  VILLAGE_CADENCE,
} from '../gameLogic.ts'

/**
 * The starting scene registers the Spaceport anchored at (-1, -1) with its footprint covering the
 * origin, plus the scenario's extra settlements (mining camp, research colony) farther out — each
 * with its OWN stage ladder. The Spaceport's stockpile slots follow the prototype `accepts` order
 * (glass, aluminum, aluminum_sheet, microchip, …), so slot 0 is glass — the only level-1 demand.
 * These tests drive village buffers directly to isolate the growth/decline rule from the belt
 * network.
 */
const VILLAGE_ANCHOR = { x: -1, y: -1 }

/** The dense building id of the village anchored at (ax, ay) (default: the origin Spaceport). */
function villageBuilding(sim: Sim, ax = 0, ay = 0): number {
  return buildingAt(sim.state.buildings, ax, ay)
}

/** Set the Spaceport's slot-0 buffer (the single level-1 demand, glass) to `n`. */
function setStage1(sim: Sim, n: number): void {
  const b = villageBuilding(sim)
  sim.state.buildings.slotCount[b * MAX_SLOTS] = n
}

/** Set building `b`'s buffer slot holding `color` to `n` (no-op if it stocks no such slot). */
function setBufferOf(sim: Sim, b: number, color: number, n: number): void {
  const bs = sim.state.buildings
  for (let k = 0; k < bs.slotN[b]!; k++) {
    const i = b * MAX_SLOTS + k
    if (bs.slotColor[i] === color) {
      bs.slotCount[i] = n
      return
    }
  }
}

/** Set the Spaceport's buffer slot holding `color` to `n` (0 if it stocks no such slot). */
function setBufferColor(sim: Sim, color: number, n: number): void {
  setBufferOf(sim, villageBuilding(sim), color, n)
}

/** Current buffer stock of `color` in the Spaceport. */
function bufferColor(sim: Sim, color: number): number {
  const b = villageBuilding(sim)
  const bs = sim.state.buildings
  for (let k = 0; k < bs.slotN[b]!; k++) {
    const i = b * MAX_SLOTS + k
    if (bs.slotColor[i] === color) return bs.slotCount[i]!
  }
  return 0
}

/** The Spaceport's current stage index (0 = level 1), or -1 if there is no village. */
function stage(sim: Sim): number {
  return villageStageAt(sim.state.villages, VILLAGE_ANCHOR.x, VILLAGE_ANCHOR.y)
}

describe('village growth / decline', () => {
  it('starts at stage 0 (level 1)', async () => {
    const sim = await bootstrapSim(1)
    expect(stage(sim)).toBe(0)
  })

  it('grows a stage when its level-1 demand stays satisfied', async () => {
    const sim = await bootstrapSim(1)
    // Keep glass topped up so level 1 (glass only) is met every cadence.
    setStage1(sim, 100_000)
    sim.scheduler.runTicks(sim.world, 700)
    // ~600 ticks of sustained satisfaction promotes it from stage 0 to stage 1.
    expect(stage(sim)).toBe(1)
  })

  it('declines a stage when a higher tier goes unsupplied, floored at level 1', async () => {
    const sim = await bootstrapSim(1)
    // Grow to stage 1 first.
    setStage1(sim, 100_000)
    sim.scheduler.runTicks(sim.world, 700)
    expect(stage(sim)).toBe(1)
    // Stage 1 (level 2) also demands aluminum (never supplied) AND now glass is cut off, so every
    // demand is unmet: after ~600 ticks it drops back to stage 0 and cannot fall below it.
    setStage1(sim, 0)
    sim.scheduler.runTicks(sim.world, 900)
    expect(stage(sim)).toBe(0)
  })

  it('consumes a demand at its authored ratePerMin, not a per-cadence floor', async () => {
    const sim = await bootstrapSim(1)
    const v = sim.state.villages
    const color = v.ladders[0]![0]!.demands[0]!.color
    // Pin the origin village to a single-stage ladder at 20/min so there is no growth/decline to
    // perturb the buffer, and clear the accumulators for a clean measurement window.
    v.ladders[0] = [{ population: 1, demands: [{ color, ratePerMin: 20 }] }]
    v.stage[0] = 0
    v.growthTimer[0] = 0
    v.declineTimer[0] = 0
    v.timer = 0
    for (let d = 0; d < 8; d++) v.demandAcc[d] = 0

    const START = 1000
    setBufferColor(sim, color, START)
    sim.scheduler.runTicks(sim.world, 3600) // exactly one in-game minute (VILLAGE_TICKS_PER_MIN)
    const consumed = START - bufferColor(sim, color)
    // Honours the authored 20/min. The old rounding floor (max(1, round(20/60))) ate 1 per cadence
    // = 60 units a minute — a 3x over-consumption that flattened every authored rate to the floor.
    expect(consumed).toBe(20)
  })

  it('honours a low rate too: 6/min consumes 6 units a minute', async () => {
    const sim = await bootstrapSim(1)
    const v = sim.state.villages
    const color = v.ladders[0]![0]!.demands[0]!.color
    v.ladders[0] = [{ population: 1, demands: [{ color, ratePerMin: 6 }] }]
    v.stage[0] = 0
    v.growthTimer[0] = 0
    v.declineTimer[0] = 0
    v.timer = 0
    for (let d = 0; d < 8; d++) v.demandAcc[d] = 0

    const START = 1000
    setBufferColor(sim, color, START)
    sim.scheduler.runTicks(sim.world, 3600)
    expect(START - bufferColor(sim, color)).toBe(6)
  })

  it('is deterministic: same seed + buffer -> identical stage and timers', async () => {
    const run = async (): Promise<Sim> => {
      const sim = await bootstrapSim(3)
      setStage1(sim, 100_000)
      sim.scheduler.runTicks(sim.world, 1000)
      return sim
    }
    const a = await run()
    const b = await run()
    // The village reached a non-trivial stage (grew), and both runs agree exactly.
    expect(stage(a)).toBe(1)
    expect(stage(a)).toBe(stage(b))
    expect(a.state.villages.growthTimer[0]).toBe(b.state.villages.growthTimer[0])
    expect(a.state.villages.declineTimer[0]).toBe(b.state.villages.declineTimer[0])
    // The ECS-visible state (no moving entities here) is identical too.
    expect(hashState(a.world)).toBe(hashState(b.world))
  })
})

/**
 * UX3 — startup grace. A freshly-founded settlement has an empty buffer, so without a grace window it
 * would begin declining (and raise the "village declining" alert) from tick 0 — before a player could
 * plausibly route supply to it. Grace suppresses decline until the settlement is first fully supplied
 * or the window elapses, whichever comes first. Indices: 0 = Spaceport (origin, has a starter kit),
 * 1 = Mining Camp, 2 = Research Colony — the latter two spawn unsupplied.
 */
describe('village startup grace (UX3)', () => {
  /** Fill every current-stage demand of village `i` to `n` in its own buffer. */
  function feedVillage(sim: Sim, i: number, n: number): void {
    const v = sim.state.villages
    const b = buildingAt(sim.state.buildings, v.vx[i]!, v.vy[i]!)
    for (const dem of v.ladders[i]![v.stage[i]!]!.demands) {
      setBufferOf(sim, b, dem.color, n)
    }
  }

  it('an unsupplied new settlement neither declines nor alerts during grace', async () => {
    const sim = await bootstrapSim(1)
    const v = sim.state.villages
    // Well past the old 600-tick decline threshold: with grace, the two new unsupplied settlements
    // (Mining Camp, Research Colony — no starter kit, unlike the origin Spaceport) still show no
    // decline and raise no "declining" alert the player can't act on.
    sim.scheduler.runTicks(sim.world, 700)
    const declining = collectAlerts(sim.state).filter((a) => a.kind === 'village_declining')
    for (const i of [1, 2]) {
      expect(v.declineTimer[i]).toBe(0)
      expect(v.graceTimer[i]).toBeGreaterThan(0)
      expect(v.graceTimer[i]).toBeLessThan(VILLAGE_DECLINE_GRACE)
      // The settlement's anchor never appears in the alert stack while it is within grace.
      expect(declining.some((a) => a.x === v.vx[i]! && a.y === v.vy[i]!)).toBe(false)
    }
  })

  it('decline resumes once the grace window has elapsed', async () => {
    const sim = await bootstrapSim(1)
    const v = sim.state.villages
    // Fast-forward the Mining Camp past its grace window, leaving its buffer empty.
    v.graceTimer[1] = 0
    v.declineTimer[1] = 0
    sim.scheduler.runTicks(sim.world, 200)
    expect(v.declineTimer[1]).toBeGreaterThan(0)
    expect(collectAlerts(sim.state).some((a) => a.kind === 'village_declining')).toBe(true)
  })

  it('the first full supply ends grace immediately', async () => {
    const sim = await bootstrapSim(1)
    const v = sim.state.villages
    expect(v.graceTimer[1]).toBe(VILLAGE_DECLINE_GRACE)
    feedVillage(sim, 1, 100_000)
    // One cadence of full supply clears the grace window (and starts the growth timer instead).
    sim.scheduler.runTicks(sim.world, VILLAGE_CADENCE + 1)
    expect(v.graceTimer[1]).toBe(0)
    expect(v.declineTimer[1]).toBe(0)
  })

  it('is deterministic and carries the remaining grace into a save', async () => {
    const run = async (): Promise<Sim> => {
      const sim = await bootstrapSim(4)
      sim.scheduler.runTicks(sim.world, 300)
      return sim
    }
    const a = await run()
    const b = await run()
    expect(hashState(a.world)).toBe(hashState(b.world))
    // Grace burned down but is still active, and it is serialized (so the window survives a save).
    const snap = serializeGameState(a.state)
    for (let i = 0; i < a.state.villages.count; i++) {
      expect(a.state.villages.graceTimer[i]).toBe(b.state.villages.graceTimer[i])
    }
    const camp = snap.villages.entries[1]!
    expect(camp.graceTimer).toBe(a.state.villages.graceTimer[1])
    expect(camp.graceTimer).toBeGreaterThan(0)
    expect(camp.graceTimer).toBeLessThan(VILLAGE_DECLINE_GRACE)
  })
})

/**
 * G3 — multiple settlements with distinct demand ladders. The abundant scenario spawns the
 * Spaceport at the origin, a Mining Camp at mid distance (Chebyshev 22–30) and a Research Colony
 * farther out (40–52), each registered with its OWN stage ladder. Registration order follows the
 * scenario's `settlements` list, so index 0 = Spaceport, 1 = Mining Camp, 2 = Research Colony.
 */
describe('multiple settlements', () => {
  /** Chebyshev distance of village `i`'s anchor from the origin. */
  function cheby(sim: Sim, i: number): number {
    const v = sim.state.villages
    return Math.max(Math.abs(v.vx[i]!), Math.abs(v.vy[i]!))
  }

  it('spawns three settlements, each with its own ladder, in the scenario distance bands', async () => {
    const sim = await bootstrapSim(1)
    const v = sim.state.villages
    expect(v.count).toBe(3)
    // Distinct ladders: Spaceport 6 stages, Mining Camp 4, Research Colony 5.
    expect(v.ladders[0]).toHaveLength(6)
    expect(v.ladders[1]).toHaveLength(4)
    expect(v.ladders[2]).toHaveLength(5)
    // Distinct level-1 demands (glass vs coke vs silicon — different colours).
    const first = (i: number): number => v.ladders[i]![0]!.demands[0]!.color
    expect(new Set([first(0), first(1), first(2)]).size).toBe(3)
    // The Spaceport holds the origin; the others sit in their scenario distance bands.
    expect(v.vx[0]).toBe(-1)
    expect(v.vy[0]).toBe(-1)
    expect(cheby(sim, 1)).toBeGreaterThanOrEqual(22)
    expect(cheby(sim, 1)).toBeLessThanOrEqual(30)
    expect(cheby(sim, 2)).toBeGreaterThanOrEqual(40)
    expect(cheby(sim, 2)).toBeLessThanOrEqual(52)
    // Each is a registered store building at its anchor (so ports can feed it).
    for (let i = 0; i < 3; i++) {
      expect(buildingAt(sim.state.buildings, v.vx[i]!, v.vy[i]!)).toBeGreaterThanOrEqual(0)
    }
  })

  it('grows and declines each settlement independently', async () => {
    const sim = await bootstrapSim(1)
    const v = sim.state.villages
    const campB = buildingAt(sim.state.buildings, v.vx[1]!, v.vy[1]!)
    const campGood = v.ladders[1]![0]!.demands[0]!.color // coke — the camp's level-1 demand
    // Feed the camp; leave the colony starved. (The Spaceport lives off its starting kit.)
    setBufferOf(sim, campB, campGood, 100_000)
    sim.scheduler.runTicks(sim.world, 700)
    // The fed camp grew (its grace cleared on first supply); the starved colony stayed floored at
    // stage 0. Its decline is still held off by the UX3 startup grace, so it accrues none yet.
    expect(v.stage[1]).toBe(1)
    expect(v.stage[2]).toBe(0)
    expect(v.declineTimer[2]).toBe(0)
    expect(v.graceTimer[2]).toBeGreaterThan(0)
    // Now cut the camp off: its stage-1 demands go unmet, so IT declines while nothing else moves
    // up. (Zero the whole buffer, not just one good.)
    setBufferOf(sim, campB, campGood, 0)
    const bs = sim.state.buildings
    for (let k = 0; k < bs.slotN[campB]!; k++) bs.slotCount[campB * MAX_SLOTS + k] = 0
    sim.scheduler.runTicks(sim.world, 900)
    expect(v.stage[1]).toBe(0)
    expect(v.stage[2]).toBe(0)
  })
})
