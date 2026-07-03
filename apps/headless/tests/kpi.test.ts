import { describe, it, expect } from 'vitest'
import { hashState } from '@factory/engine/persistence'
import { bootstrapSim, type Sim } from '../bootstrap.ts'
import { runKpi, runKpiSweep, sampleKpi } from '../kpi.ts'
import {
  MAX_SLOTS,
  buildingAt,
  serializeGameState,
  techTypeOf,
  enqueuePlaceBuilding,
  enqueueSetActiveResearch,
} from '../gameLogic.ts'

/**
 * The M7 economy-KPI harness. These cover the two guarantees that matter: the harness is a pure,
 * read-only observer (chunked sampling produces byte-identical sim state to one long run, and the
 * report itself is reproducible from seed + cadence), and its derived KPIs actually track what the
 * played world does (a driven research completion shows up as a finite time-to-first-research; a
 * bare do-nothing seed reports the declining-village baseline).
 */

/** item.research_pack colour — the resource a lab stockpiles (mirrors research.test.ts). */
const PACK = 3062647
const SMELTING = techTypeOf('tech.basic_smelting')

/** Full state hash including the base mod's out-of-ECS stores (villages, research, …). */
function fullHash(sim: Sim): string {
  return hashState(sim.world, { base: serializeGameState(sim.state) })
}

describe('KPI harness — read-only observer', () => {
  it('chunked sampling leaves sim state byte-identical to one uninterrupted run', async () => {
    const sampled = await bootstrapSim(7)
    runKpi(sampled, 7, { ticks: 1200, sampleEvery: 300 })

    const oneShot = await bootstrapSim(7)
    oneShot.scheduler.runTicks(oneShot.world, 1200)

    expect(fullHash(sampled)).toBe(fullHash(oneShot))
  })

  it('produces an identical report for the same seed + ticks + cadence', async () => {
    const a = runKpi(await bootstrapSim(4), 4, { ticks: 900, sampleEvery: 300 })
    const b = runKpi(await bootstrapSim(4), 4, { ticks: 900, sampleEvery: 300 })
    expect(a).toEqual(b)
  })

  it('samples at tick 0 then every cadence through the run', async () => {
    const report = runKpi(await bootstrapSim(1), 1, { ticks: 900, sampleEvery: 300 })
    // baseline + one sample per 300-tick chunk (900 / 300 = 3) = 4 samples.
    expect(report.samples).toHaveLength(4)
    expect(report.samples.map((s) => s.tick)).toEqual([0, 300, 600, 900])
    expect(report.sampleEvery).toBe(300)
  })

  it('handles a ragged final chunk without over-running the tick budget', async () => {
    const report = runKpi(await bootstrapSim(1), 1, { ticks: 700, sampleEvery: 300 })
    // 300 + 300 + 100 → samples at 0, 300, 600, 700; the last chunk is short but still sampled.
    expect(report.samples.map((s) => s.tick)).toEqual([0, 300, 600, 700])
    expect(report.ticks).toBe(700)
  })
})

describe('KPI harness — derived metrics', () => {
  it('reports a finite time-to-first-research once a driven tech completes', async () => {
    const sim = await bootstrapSim(1)
    // Place a lab, fill its pack buffer directly, and select a cheap tech (as research.test.ts does).
    enqueuePlaceBuilding(sim.world, {
      x: 20,
      y: 20,
      w: 2,
      h: 2,
      color: 0x2b7573,
      accepts: [{ color: PACK, cap: 1000 }],
      researchLab: true,
    })
    sim.scheduler.runTicks(sim.world, 1)
    sim.state.buildings.slotCount[buildingAt(sim.state.buildings, 20, 20) * MAX_SLOTS] = 100
    enqueueSetActiveResearch(sim.world, { tech: SMELTING, cost: [{ color: PACK, amount: 20 }] })

    const report = runKpi(sim, 1, { ticks: 1200, sampleEvery: 300 })
    expect(report.researchCompleted).toBeGreaterThan(0)
    expect(report.timeToFirstResearch).not.toBeNull()
    // The 20-pack cost drains within the first cadences, so it lands by the first post-baseline
    // sample (~tick 300, plus the 1-tick placement offset that shifts every sample).
    expect(report.timeToFirstResearch!).toBeLessThanOrEqual(400)
  })

  it('reports the do-nothing baseline for a bare seed: no research, village drains to decline', async () => {
    const report = runKpi(await bootstrapSim(1), 1, { ticks: 1200, sampleEvery: 300 })
    // Nothing is built, so no pack is ever produced and no tech completes.
    expect(report.timeToFirstResearch).toBeNull()
    expect(report.researchCompleted).toBe(0)
    // The scenario's starting kit fuels at most a brief growth; with no factory it then runs dry and
    // the village stops being fully fed — so `village_declining` surfaces as the run's bottleneck.
    expect(report.bottlenecks.some((b) => b.kind === 'village_declining')).toBe(true)
    // And it ends no higher than it ever peaked (the kit cannot sustain growth).
    expect(report.finalVillageStageTotal).toBeLessThanOrEqual(report.peakVillageStage)
  })

  it('sampleKpi reads the live world without mutating it', async () => {
    const sim = await bootstrapSim(2)
    sim.scheduler.runTicks(sim.world, 120)
    const before = fullHash(sim)
    const sample = sampleKpi(sim.state, sim.world.tick)
    expect(sample.tick).toBe(sim.world.tick)
    expect(fullHash(sim)).toBe(before) // reading KPIs changed nothing
  })
})

describe('KPI harness — cross-seed sweep', () => {
  it('runs every seed and mirrors each seed’s standalone report', async () => {
    const seeds = [1, 2, 3]
    const sweep = await runKpiSweep(bootstrapSim, seeds, { ticks: 900, sampleEvery: 300 })

    expect(sweep.seeds).toEqual(seeds)
    expect(sweep.perSeed.map((r) => r.seed)).toEqual(seeds)
    expect(sweep.summary.seedCount).toBe(seeds.length)
    // Each folded report is exactly what a standalone run of that seed produces.
    for (const seed of seeds) {
      const solo = runKpi(await bootstrapSim(seed), seed, { ticks: 900, sampleEvery: 300 })
      expect(sweep.perSeed.find((r) => r.seed === seed)).toEqual(solo)
    }
  })

  it('is reproducible: same boot + seeds + cadence → identical sweep report', async () => {
    const a = await runKpiSweep(bootstrapSim, [4, 5], { ticks: 900, sampleEvery: 300 })
    const b = await runKpiSweep(bootstrapSim, [4, 5], { ticks: 900, sampleEvery: 300 })
    expect(a).toEqual(b)
  })

  it('summarizes the do-nothing baseline: no seed researches, all decline', async () => {
    const sweep = await runKpiSweep(bootstrapSim, [1, 2, 3], { ticks: 1200, sampleEvery: 300 })
    // Nothing is built on any seed, so no tech ever completes.
    expect(sweep.summary.seedsReachingResearch).toBe(0)
    expect(sweep.summary.timeToFirstResearch).toBeNull()
    expect(sweep.summary.researchCompleted).toEqual({ min: 0, max: 0, mean: 0 })
    // Every bare seed drains to a declining village, so that is the shared bottleneck across all 3.
    const declining = sweep.summary.commonBottlenecks.find((b) => b.kind === 'village_declining')
    expect(declining?.seeds).toBe(3)
  })

  it('the drive hook stages a factory per seed, lifting the research KPI off baseline', async () => {
    // Drive the same lab+pack+research setup the derived-metrics test uses, for every seed.
    const drive = (sim: Sim): void => {
      enqueuePlaceBuilding(sim.world, {
        x: 20,
        y: 20,
        w: 2,
        h: 2,
        color: 0x2b7573,
        accepts: [{ color: PACK, cap: 1000 }],
        researchLab: true,
      })
      sim.scheduler.runTicks(sim.world, 1)
      sim.state.buildings.slotCount[buildingAt(sim.state.buildings, 20, 20) * MAX_SLOTS] = 100
      enqueueSetActiveResearch(sim.world, { tech: SMELTING, cost: [{ color: PACK, amount: 20 }] })
    }
    const sweep = await runKpiSweep(bootstrapSim, [1, 2], { ticks: 1200, sampleEvery: 300, drive })

    expect(sweep.summary.seedsReachingResearch).toBe(2)
    expect(sweep.summary.timeToFirstResearch).not.toBeNull()
    expect(sweep.summary.researchCompleted.min).toBeGreaterThan(0)
    for (const r of sweep.perSeed) expect(r.timeToFirstResearch).not.toBeNull()
  })
})
