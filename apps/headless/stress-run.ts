import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { entityCount } from '@factory/engine/core'
import { hashState } from '@factory/engine/persistence'
import { bootstrapSim } from './bootstrap.ts'
import { serializeGameState } from './gameLogic.ts'
import { buildStressMap } from './stressmap.ts'

/**
 * Stress-map runner: builds a big tiled factory ({@link ./stressmap.ts}), runs it headlessly and
 * reports entity count + per-tick cost + a reproducible hash — a perf/scale/regression harness for
 * "thousands of things running". Optionally writes a `.factorysave` you can load in the real game to
 * watch it.
 *
 * Usage: pnpm stress [cells] [ticks] [--save[=path]]
 *   cells   how many production-chain cells to tile   (default 150 → several thousand entities)
 *   ticks   how many ticks to simulate after building (default 600)
 *   --save  also write a loadable save (default ./stressmap.factorysave)
 */
function parseArg(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

async function main(): Promise<void> {
  const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  const cells = parseArg(positional[0], 150)
  const ticks = parseArg(positional[1], 600)
  const seed = 1
  const saveFlag = process.argv.find((a) => a === '--save' || a.startsWith('--save='))
  const savePath = saveFlag?.includes('=') ? saveFlag.split('=')[1]! : 'stressmap.factorysave'

  const sim = await bootstrapSim(seed, { startScene: false })
  const built = buildStressMap(sim, cells)
  const entitiesAfterBuild = entityCount(sim.world)

  // Warm up (JIT) off the clock, then time the steady-state simulation.
  sim.scheduler.runTicks(sim.world, 60)
  const start = performance.now()
  sim.scheduler.runTicks(sim.world, ticks)
  const msPerTick = (performance.now() - start) / ticks

  const result: Record<string, string | number> = {
    cells: built.cells,
    grid: `${built.cols}×${built.rows}`,
    entities: entitiesAfterBuild,
    ticksSimulated: ticks + 60,
    msPerTick: Number(msPerTick.toFixed(3)),
    fps: Math.round(1000 / msPerTick),
    treasuryBanked: sim.state.treasury.n, // distinct colours the depots have banked (chain is live)
    stateHash: hashState(sim.world, { base: serializeGameState(sim.state) }),
  }

  console.log('=== stress-map run ===')
  for (const [k, v] of Object.entries(result)) console.log(`${k.padEnd(15)} ${v}`)

  if (saveFlag) {
    const snapshot = sim.serialize() as { version: number; tick: number; seed: number }
    const now = Date.now()
    const file = {
      fileVersion: 1,
      meta: {
        id: 'stressmap',
        name: `Stress Map (${built.cells} cells)`,
        kind: 'manual' as const,
        tick: snapshot.tick,
        seed: snapshot.seed,
        snapshotVersion: snapshot.version,
        createdAt: now,
        updatedAt: now,
      },
      snapshot,
    }
    const out = resolve(process.cwd(), savePath)
    writeFileSync(out, JSON.stringify(file), 'utf8')
    console.log(`\nsaved  ${out}`)
    console.log('to view: copy it as stressmap.factorysave into the game saves folder')
    console.log('  macOS (dev): ~/Library/Application Support/Electron/saves/')
    console.log('then open it from the in-game Load menu.')
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
