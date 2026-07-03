import { bootstrapSim } from './bootstrap.ts'
import { runKpi, runKpiSweep, formatKpiReport, formatKpiSweep } from './kpi.ts'
import { playFirstResearch } from './playbook.ts'

/**
 * Economy-KPI runner (roadmap M7): boot a seed, run it, and print the dynamic economy KPIs
 * (time-to-first-research, village-growth curve, bottlenecks). The static economy shape has its
 * own tool (`pnpm balance`); this reports what a played-out seed actually does over time.
 *
 * Usage:
 *   pnpm kpi [seed] [ticks] [sampleEvery]              single seed → full sample curve (do-nothing)
 *   pnpm kpi <s0,s1,...> [ticks] [sampleEvery]         comma-separated seeds → cross-seed sweep
 *   pnpm kpi play [seed|s0,s1,...] [ticks] [every]     drive the authored playthrough first
 *
 * A bare boot places no factory, so the numbers are the do-nothing baseline for the seed(s) — a
 * regression floor (village declines, research never starts). The `play` prefix runs the authored
 * playbook ({@link playFirstResearch}) — a real belt-fed factory to the first research — before
 * sampling, so the KPIs reflect a played factory. The sampling/report machinery is independent of how
 * the factory is built; the sweep passes the playbook as its per-seed `drive` hook.
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
  // An optional leading `play` token drives the authored playthrough before sampling.
  const argv = process.argv.slice(2)
  const play = argv[0] === 'play'
  const rest = play ? argv.slice(1) : argv

  const seedArg = rest[0] ?? '1'
  const ticks = parseArg(rest[1], 18_000) // ~5 min at 60 tps
  const sampleEvery = parseArg(rest[2], 1800) // ~30s at 60 tps

  // A comma in the seed arg switches to a cross-seed sweep; otherwise it's a single-seed curve.
  if (seedArg.includes(',')) {
    const seeds = parseSeeds(seedArg)
    const report = await runKpiSweep(bootstrapSim, seeds, {
      ticks,
      sampleEvery,
      ...(play ? { drive: (sim) => void playFirstResearch(sim) } : {}),
    })
    console.log(formatKpiSweep(report, 60))
    return
  }

  const seed = parseArg(seedArg, 1)
  const sim = await bootstrapSim(seed)
  if (play) {
    const built = playFirstResearch(sim)
    console.log(
      `[play] authored factory: ${built.feedersWired}/${built.minersPlaced} raw feeders wired`,
    )
  }
  const report = runKpi(sim, seed, { ticks, sampleEvery })
  console.log(formatKpiReport(report, sim.scheduler.tickRate))
}

main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
