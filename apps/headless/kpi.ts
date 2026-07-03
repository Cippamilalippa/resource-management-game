/**
 * Headless economy-KPI harness (roadmap M7). Boots a sim, runs it for N ticks while sampling the
 * base game's read-only HUD selectors at a fixed cadence, and folds the samples into a structured
 * report of the *dynamic* economy KPIs of a played-out seed — the counterpart to the static shape
 * the balance tool (`pnpm balance`) reports. This is the instrument the M7 tuning bullets hang off:
 * it turns "does this seed grow / research / stall?" into numbers a regression can pin.
 *
 * It is pure host-side analysis: it drives the scheduler and reads through the sim's public
 * selectors (`villageStatuses`, `researchProgress`, `collectAlerts`, `productionFlows`, surfaced by
 * the `gameLogic` barrel) — it never reaches into the sandboxed sim or mutates state, so it cannot
 * affect determinism. Same seed + tick count + cadence → identical report (see kpi.test.ts).
 *
 * Note the harness only samples; it does not *play*. A bare boot lays out the starting scene (a
 * village + orchard + deposits) but places no factory, so an un-driven run reports the do-nothing
 * baseline (the village declines to its floor, research never starts). Callers that want a
 * played-out seed drive placements through the command bridge before/between runs, exactly as the
 * headless tests do; the authored playthrough scenarios are the follow-on M7 bullets.
 */
import type { Sim } from './bootstrap.ts'
import {
  RESEARCH_NONE,
  villageStatuses,
  researchProgress,
  collectAlerts,
  productionFlows,
  type AlertKind,
  type GameState,
} from './gameLogic.ts'

/** A single point-in-time reading of the economy KPIs, taken every `sampleEvery` ticks. */
export interface KpiSample {
  /** Sim tick this sample was taken at. */
  readonly tick: number
  /** Sum of every village's stage index (0-based) — the coarse "how far have villages grown" number. */
  readonly villageStageTotal: number
  /** The highest single-village stage index reached at this tick. */
  readonly villageStageMax: number
  /** How many villages currently meet every demand of their stage. */
  readonly villagesFullyFed: number
  /** Number of technologies completed so far (monotonic across a run). */
  readonly researchCompleted: number
  /** Active technology integer id, or {@link RESEARCH_NONE} when research is idle. */
  readonly activeResearch: number
  /** Stalled crafters missing an input this tick. */
  readonly crafterMissingInput: number
  /** Stalled crafters with a full output this tick. */
  readonly crafterOutputFull: number
  /** Villages accruing decline this tick. */
  readonly villagesDeclining: number
  /** Installed production capacity summed across every resource colour (units/tick, if fully fed). */
  readonly throughputTotal: number
}

/** The most persistent bottleneck across a run: an alert kind + resource, and how often it recurred. */
export interface KpiBottleneck {
  readonly kind: AlertKind
  /** Blocking/missing resource colour, or {@link RESEARCH_NONE} for a colourless alert (declining village). */
  readonly color: number
  /** Number of samples in which this exact (kind, colour) alert appeared. */
  readonly occurrences: number
}

/** The whole-run KPI report: the raw sample curve plus the derived headline figures. */
export interface KpiReport {
  readonly seed: number
  readonly ticks: number
  readonly sampleEvery: number
  /** The KPI curve: one sample at tick 0, then every `sampleEvery` ticks through `ticks`. */
  readonly samples: readonly KpiSample[]
  /** First tick at which a technology had completed, or `null` if none did within the run. */
  readonly timeToFirstResearch: number | null
  /** Technologies completed by the end of the run. */
  readonly researchCompleted: number
  /** Highest single-village stage reached at any point in the run. */
  readonly peakVillageStage: number
  /** Sum of village stages at the final sample — where the run left the settlements. */
  readonly finalVillageStageTotal: number
  /** The recurring bottlenecks, most persistent first (capped to the top few for the summary). */
  readonly bottlenecks: readonly KpiBottleneck[]
}

/** Take one KPI reading of the current sim state. Read-only; safe to call between `runTicks` chunks. */
export function sampleKpi(state: GameState, tick: number): KpiSample {
  let villageStageTotal = 0
  let villageStageMax = 0
  let villagesFullyFed = 0
  const villages = villageStatuses(state)
  for (let i = 0; i < villages.length; i++) {
    const v = villages[i]!
    villageStageTotal += v.stage
    if (v.stage > villageStageMax) villageStageMax = v.stage
    let allMet = true
    for (let d = 0; d < v.demands.length; d++) if (!v.demands[d]!.met) allMet = false
    if (allMet && v.demands.length > 0) villagesFullyFed++
  }

  const research = researchProgress(state)

  let crafterMissingInput = 0
  let crafterOutputFull = 0
  let villagesDeclining = 0
  const alerts = collectAlerts(state)
  for (let i = 0; i < alerts.length; i++) {
    const kind = alerts[i]!.kind
    if (kind === 'crafter_missing_input') crafterMissingInput++
    else if (kind === 'crafter_output_full') crafterOutputFull++
    else villagesDeclining++
  }

  let throughputTotal = 0
  const flows = productionFlows(state)
  for (let i = 0; i < flows.length; i++) throughputTotal += flows[i]!.produced

  return {
    tick,
    villageStageTotal,
    villageStageMax,
    villagesFullyFed,
    researchCompleted: research.completed.length,
    activeResearch: research.activeTech,
    crafterMissingInput,
    crafterOutputFull,
    villagesDeclining,
    throughputTotal,
  }
}

/** Options for {@link runKpi}. */
export interface RunKpiOptions {
  /** How many ticks to run in total. */
  readonly ticks: number
  /** Sample cadence in ticks (also the resolution of `timeToFirstResearch`). Default 300 (~5s at 60 tps). */
  readonly sampleEvery?: number
}

/**
 * Run `sim` for `ticks`, sampling KPIs every `sampleEvery` ticks (plus an initial sample at the
 * current tick), and fold the samples into a {@link KpiReport}. The caller owns the sim's factory:
 * boot it, optionally drive placements/research through the command bridge, then hand it here.
 * Advances the scheduler in fixed chunks so the sampled run is byte-identical to one long `runTicks`.
 */
export function runKpi(
  sim: Sim,
  seed: number,
  { ticks, sampleEvery = 300 }: RunKpiOptions,
): KpiReport {
  const step = Math.max(1, sampleEvery)
  const samples: KpiSample[] = []
  // Count each distinct (kind, colour) alert across every sample to surface the run's real bottleneck.
  const alertTally = new Map<string, KpiBottleneck>()

  const tally = (state: GameState): void => {
    for (const alert of collectAlerts(state)) {
      const color = alert.color ?? RESEARCH_NONE
      const key = `${alert.kind}:${color}`
      const prev = alertTally.get(key)
      if (prev) alertTally.set(key, { ...prev, occurrences: prev.occurrences + 1 })
      else alertTally.set(key, { kind: alert.kind, color, occurrences: 1 })
    }
  }

  const record = (): void => {
    samples.push(sampleKpi(sim.state, sim.world.tick))
    tally(sim.state)
  }

  record() // baseline sample at the starting tick
  let remaining = ticks
  while (remaining > 0) {
    const chunk = Math.min(step, remaining)
    sim.scheduler.runTicks(sim.world, chunk)
    remaining -= chunk
    record()
  }

  let timeToFirstResearch: number | null = null
  let peakVillageStage = 0
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!
    if (timeToFirstResearch === null && s.researchCompleted > 0) timeToFirstResearch = s.tick
    if (s.villageStageMax > peakVillageStage) peakVillageStage = s.villageStageMax
  }
  const last = samples[samples.length - 1]!

  const bottlenecks = [...alertTally.values()].sort(
    (a, b) => b.occurrences - a.occurrences || a.kind.localeCompare(b.kind) || a.color - b.color,
  )

  return {
    seed,
    ticks,
    sampleEvery: step,
    samples,
    timeToFirstResearch,
    researchCompleted: last.researchCompleted,
    peakVillageStage,
    finalVillageStageTotal: last.villageStageTotal,
    bottlenecks,
  }
}

/**
 * Boot a fresh sim for a seed. The sweep owns nothing about mod discovery/wiring — the caller
 * supplies this (the headless runner passes `bootstrapSim`), so `kpi.ts` stays free of the async
 * bootstrap dependency and remains unit-testable with a stub.
 */
export type SimBoot = (seed: number) => Promise<Sim>

/**
 * Optional per-seed driver run once, after boot and before the sampled run: the seam an authored
 * playthrough plugs into (place a factory / select research through the command bridge). It may only
 * read state and enqueue commands — never mutate the sim directly — so the run stays deterministic.
 */
export type SimDriver = (sim: Sim, seed: number) => void | Promise<void>

/** Min / max / mean of one KPI across the seeds in a sweep. */
export interface KpiStat {
  readonly min: number
  readonly max: number
  readonly mean: number
}

/** A bottleneck aggregated across the whole seed set: how many seeds hit it, and how often overall. */
export interface KpiSweepBottleneck {
  readonly kind: AlertKind
  /** Blocking/missing resource colour, or {@link RESEARCH_NONE} for a colourless (village) alert. */
  readonly color: number
  /** Number of seeds in which this exact (kind, colour) bottleneck appeared at all. */
  readonly seeds: number
  /** Total samples affected, summed across every seed. */
  readonly occurrences: number
}

/** The headline figures folded across a whole seed set — the sweep's regression surface. */
export interface KpiSweepSummary {
  readonly seedCount: number
  /** How many seeds completed at least one technology within the run. */
  readonly seedsReachingResearch: number
  /** Time-to-first-research across only the seeds that reached it, or `null` if none did. */
  readonly timeToFirstResearch: KpiStat | null
  readonly researchCompleted: KpiStat
  readonly peakVillageStage: KpiStat
  readonly finalVillageStageTotal: KpiStat
  /** Bottlenecks ranked by how many seeds hit them (then total occurrences), most common first. */
  readonly commonBottlenecks: readonly KpiSweepBottleneck[]
}

/** A whole-seed-set report: each seed's individual {@link KpiReport} plus the cross-seed summary. */
export interface KpiSweepReport {
  readonly seeds: readonly number[]
  readonly ticks: number
  readonly sampleEvery: number
  readonly perSeed: readonly KpiReport[]
  readonly summary: KpiSweepSummary
}

/** Min/max/mean of a value list (zeroed for an empty list, so the summary stays finite). */
function statOf(values: readonly number[]): KpiStat {
  if (values.length === 0) return { min: 0, max: 0, mean: 0 }
  let min = values[0]!
  let max = values[0]!
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!
    if (v < min) min = v
    if (v > max) max = v
    sum += v
  }
  return { min, max, mean: sum / values.length }
}

/** Fold the per-seed reports into the cross-seed {@link KpiSweepSummary}. Pure + order-independent. */
function summarizeSweep(perSeed: readonly KpiReport[]): KpiSweepSummary {
  const firstResearch: number[] = []
  for (let i = 0; i < perSeed.length; i++) {
    const t = perSeed[i]!.timeToFirstResearch
    if (t !== null) firstResearch.push(t)
  }

  // Tally each distinct (kind, colour) bottleneck across seeds: one seed contributes to `seeds` once
  // (its per-seed report already deduped the kind), and adds its sample count to `occurrences`.
  const tally = new Map<
    string,
    { kind: AlertKind; color: number; seeds: number; occurrences: number }
  >()
  for (let i = 0; i < perSeed.length; i++) {
    const bs = perSeed[i]!.bottlenecks
    for (let j = 0; j < bs.length; j++) {
      const b = bs[j]!
      const key = `${b.kind}:${b.color}`
      const prev = tally.get(key)
      if (prev) {
        prev.seeds += 1
        prev.occurrences += b.occurrences
      } else {
        tally.set(key, { kind: b.kind, color: b.color, seeds: 1, occurrences: b.occurrences })
      }
    }
  }
  const commonBottlenecks = [...tally.values()].sort(
    (a, b) =>
      b.seeds - a.seeds ||
      b.occurrences - a.occurrences ||
      a.kind.localeCompare(b.kind) ||
      a.color - b.color,
  )

  return {
    seedCount: perSeed.length,
    seedsReachingResearch: firstResearch.length,
    timeToFirstResearch: firstResearch.length > 0 ? statOf(firstResearch) : null,
    researchCompleted: statOf(perSeed.map((r) => r.researchCompleted)),
    peakVillageStage: statOf(perSeed.map((r) => r.peakVillageStage)),
    finalVillageStageTotal: statOf(perSeed.map((r) => r.finalVillageStageTotal)),
    commonBottlenecks,
  }
}

/**
 * Run the KPI harness across a set of seeds and fold the results into a {@link KpiSweepReport}: the
 * dynamic counterpart to a single {@link runKpi}, and the instrument the M7 tuning bullets read to
 * see how a change moves the economy *across* seeds rather than on one lucky layout. Seeds are booted
 * and run in the given order (an optional `drive` hook stages a factory per seed before sampling);
 * the whole thing is deterministic — same boot + seeds + cadence → identical report.
 */
export async function runKpiSweep(
  boot: SimBoot,
  seeds: readonly number[],
  options: RunKpiOptions & { readonly drive?: SimDriver },
): Promise<KpiSweepReport> {
  const { drive, ...runOpts } = options
  const perSeed: KpiReport[] = []
  for (let i = 0; i < seeds.length; i++) {
    const seed = seeds[i]!
    const sim = await boot(seed)
    if (drive) await drive(sim, seed)
    perSeed.push(runKpi(sim, seed, runOpts))
  }
  return {
    seeds: [...seeds],
    ticks: runOpts.ticks,
    sampleEvery: perSeed[0]?.sampleEvery ?? Math.max(1, runOpts.sampleEvery ?? 300),
    perSeed,
    summary: summarizeSweep(perSeed),
  }
}

/** Render a {@link KpiReport} as a human-readable block for the `pnpm kpi` CLI. */
export function formatKpiReport(report: KpiReport, tickRate: number): string {
  const lines: string[] = []
  const secs = (t: number): string => `${(t / tickRate).toFixed(1)}s`
  lines.push('=== economy KPIs ===')
  lines.push(`seed              ${report.seed}`)
  lines.push(
    `ticks             ${report.ticks} (@${tickRate} tps, sample every ${report.sampleEvery})`,
  )
  lines.push(
    `time-to-research  ${report.timeToFirstResearch === null ? 'never' : `${report.timeToFirstResearch} (${secs(report.timeToFirstResearch)})`}`,
  )
  lines.push(`techs completed   ${report.researchCompleted}`)
  lines.push(`peak village lvl  ${report.peakVillageStage + 1}`)
  lines.push(`final stage total ${report.finalVillageStageTotal}`)
  if (report.bottlenecks.length === 0) {
    lines.push('bottlenecks       none')
  } else {
    lines.push('bottlenecks       (kind, colour, samples affected)')
    for (const b of report.bottlenecks.slice(0, 5)) {
      lines.push(
        `  - ${b.kind.padEnd(22)} #${b.color.toString(16).padStart(6, '0')}  x${b.occurrences}`,
      )
    }
  }
  lines.push('village-stage / throughput curve:')
  for (const s of report.samples) {
    lines.push(
      `  t=${String(s.tick).padStart(6)}  stageTotal=${s.villageStageTotal}  fed=${s.villagesFullyFed}  research=${s.researchCompleted}  throughput=${s.throughputTotal.toFixed(2)}  starved=${s.crafterMissingInput}`,
    )
  }
  return lines.join('\n')
}

/** Render a {@link KpiSweepReport} as a human-readable block for the `pnpm kpi` sweep CLI. */
export function formatKpiSweep(report: KpiSweepReport, tickRate: number): string {
  const lines: string[] = []
  const secs = (t: number): string => `${(t / tickRate).toFixed(1)}s`
  const stat = (s: KpiStat): string => `min ${s.min}  mean ${s.mean.toFixed(1)}  max ${s.max}`
  // Stage indices are 0-based; villages are shown as 1-based *levels* here (as the single report does).
  const stageStat = (s: KpiStat): string =>
    `min ${s.min + 1}  mean ${(s.mean + 1).toFixed(1)}  max ${s.max + 1}`
  const { summary } = report
  lines.push('=== economy KPI sweep ===')
  lines.push(`seeds             ${report.seeds.join(', ')} (${summary.seedCount})`)
  lines.push(
    `ticks             ${report.ticks} (@${tickRate} tps, sample every ${report.sampleEvery})`,
  )
  lines.push('per-seed:')
  for (const r of report.perSeed) {
    const ttr = r.timeToFirstResearch === null ? 'never' : secs(r.timeToFirstResearch)
    lines.push(
      `  seed ${String(r.seed).padStart(6)}  research=${r.researchCompleted}  ttr=${ttr.padStart(7)}  peakStage=${r.peakVillageStage + 1}  finalTotal=${r.finalVillageStageTotal}`,
    )
  }
  lines.push('summary:')
  lines.push(`  seeds reaching research  ${summary.seedsReachingResearch}/${summary.seedCount}`)
  lines.push(
    `  time-to-research         ${summary.timeToFirstResearch === null ? 'never (no seed)' : stat(summary.timeToFirstResearch)}`,
  )
  lines.push(`  techs completed          ${stat(summary.researchCompleted)}`)
  lines.push(`  peak village level       ${stageStat(summary.peakVillageStage)}`)
  lines.push(`  final stage total        ${stat(summary.finalVillageStageTotal)}`)
  if (summary.commonBottlenecks.length === 0) {
    lines.push('  common bottlenecks       none')
  } else {
    lines.push('  common bottlenecks       (kind, colour, seeds, total samples)')
    for (const b of summary.commonBottlenecks.slice(0, 5)) {
      lines.push(
        `    - ${b.kind.padEnd(22)} #${b.color.toString(16).padStart(6, '0')}  ${b.seeds} seeds  x${b.occurrences}`,
      )
    }
  }
  return lines.join('\n')
}
