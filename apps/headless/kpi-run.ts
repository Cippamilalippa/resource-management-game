import { bootstrapSim } from './bootstrap.ts'
import { runKpi, runKpiSweep, formatKpiReport, formatKpiSweep } from './kpi.ts'

/**
 * Economy-KPI runner (roadmap M7): boot a seed, run it, and print the dynamic economy KPIs
 * (time-to-first-research, village-growth curve, bottlenecks). The static economy shape has its
 * own tool (`pnpm balance`); this reports what a played-out seed actually does over time.
 *
 * Usage:
 *   pnpm kpi [seed] [ticks] [sampleEvery]            single seed → full sample curve
 *   pnpm kpi <s0,s1,...> [ticks] [sampleEvery]       comma-separated seeds → cross-seed sweep
 *
 * A bare boot places no factory, so the numbers are the do-nothing baseline for the seed(s) —
 * useful as a regression floor. Driving a real playthrough is the next M7 step (an authored
 * scenario); the sampling/report machinery here is deliberately independent of how the factory gets
 * built, and the sweep takes an optional per-seed `drive` hook that a playbook plugs into.
 */
function parseArg(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** Parse a comma-separated seed list (`1,2,3`), keeping only finite values. */
function parseSeeds(value: string | undefined): number[] {
  if (value === undefined) return []
  return value
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n))
}

async function main(): Promise<void> {
  const seedArg = process.argv[2] ?? '1'
  const ticks = parseArg(process.argv[3], 18_000) // ~5 min at 60 tps
  const sampleEvery = parseArg(process.argv[4], 1800) // ~30s at 60 tps

  // A comma in the seed arg switches to a cross-seed sweep; otherwise it's a single-seed curve.
  if (seedArg.includes(',')) {
    const seeds = parseSeeds(seedArg)
    const report = await runKpiSweep(bootstrapSim, seeds, { ticks, sampleEvery })
    console.log(formatKpiSweep(report, 60))
    return
  }

  const seed = parseArg(seedArg, 1)
  const sim = await bootstrapSim(seed)
  const report = runKpi(sim, seed, { ticks, sampleEvery })
  console.log(formatKpiReport(report, sim.scheduler.tickRate))
}

main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
