import { describe, it, expect } from 'vitest'
import { hashState, hashSnapshot } from '@factory/engine/persistence'
import { bootstrapSim, type Sim } from '../bootstrap.ts'
import { playFirstResearch } from '../playbook.ts'
import { runKpi } from '../kpi.ts'
import { techTypeOf } from '../gameLogic.ts'

/**
 * The authored played-out scenario (roadmap M7): {@link playFirstResearch} reads the freshly-booted
 * scene and hand-routes a real belt-fed factory — three miners feeding a refine/smelt chain into a
 * lab — then selects the first research. These tests pin the two properties that matter: it is fully
 * deterministic (the harness's non-negotiable guarantee — same seed → same commands → same hash), and
 * it actually plays (the chain completes the first technology, moving the KPIs off the do-nothing
 * baseline). The routing is layout-dependent, so liveness is asserted on seeds known to wire cleanly.
 */

/** `tech.oil_refining` — the first earnable technology the playbook researches. */
const FIRST_TECH = techTypeOf('tech.oil_refining')

/** Boot, drive the playbook, run `ticks`, return the sim. */
async function play(seed: number, ticks: number): Promise<Sim> {
  const sim = await bootstrapSim(seed)
  playFirstResearch(sim)
  sim.scheduler.runTicks(sim.world, ticks)
  return sim
}

describe('authored playbook', () => {
  it('places a miner per deposit and wires every feeder on a clean layout', async () => {
    const sim = await bootstrapSim(1)
    const built = playFirstResearch(sim)
    expect(built.minersPlaced).toBe(3) // the default scenario has bauxite, coal and silica
    expect(built.feedersWired).toBe(built.minersPlaced)
  })

  it('is deterministic: same seed → identical hash after driving and running', async () => {
    const a = await play(7, 5000)
    const b = await play(7, 5000)
    expect(hashState(a.world)).toBe(hashState(b.world))
    expect(hashSnapshot(a.serialize())).toBe(hashSnapshot(b.serialize()))
  })

  it('drives a live factory: raw flows and the first research completes', async () => {
    const sim = await play(1, 18_000)
    // The chain reached the lab and the 30-pack tech was researched.
    expect(sim.state.research.completed).toContain(FIRST_TECH)
  })

  it('moves the KPIs off the do-nothing baseline (research + throughput)', async () => {
    const driven = await bootstrapSim(1)
    playFirstResearch(driven)
    const report = runKpi(driven, 1, { ticks: 18_000, sampleEvery: 3000 })
    expect(report.timeToFirstResearch).not.toBeNull() // a played factory researches; a bare boot never does
    expect(report.researchCompleted).toBeGreaterThan(0)
    // The factory is actually producing — some installed throughput is sampled.
    expect(report.samples.some((s) => s.throughputTotal > 0)).toBe(true)
  })

  it('leaves the world untouched until driven (no placements from a bare boot)', async () => {
    const bare = await bootstrapSim(1)
    const before = bare.state.buildings.count
    // The origin scene has a village + orchard but no factory; the playbook adds the machines.
    const driven = await bootstrapSim(1)
    playFirstResearch(driven)
    expect(driven.state.buildings.count).toBeGreaterThan(before)
  })
})
