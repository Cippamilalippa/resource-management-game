import { entityCount } from '@factory/engine/core'
import { hashState } from '@factory/engine/persistence'
import { bootstrapSim } from './bootstrap.ts'
import { serializeGameState } from './gameLogic.ts'

/**
 * Sim-only runner (no Pixi, no Electron). Boots the sim with a seed, runs N ticks
 * headlessly and prints the final state — including a reproducible hash. This is
 * the harness future balancing/regression tests hang off.
 *
 * Usage: pnpm headless [seed] [ticks]
 */
function parseArg(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

async function main(): Promise<void> {
  const seed = parseArg(process.argv[2], 1)
  const ticks = parseArg(process.argv[3], 1000)

  const { world, scheduler, load, state } = await bootstrapSim(seed)
  scheduler.runTicks(world, ticks)

  const result = {
    seed,
    ticks,
    tickRate: scheduler.tickRate,
    modsLoaded: load.order.map((m) => `${m.id}@${m.version}`),
    prototypeCount: load.prototypeCount,
    entityCount: entityCount(world),
    systemRuns: world.stats.systemRuns,
    rngState: world.rng.getState(),
    // Fold the base mod's out-of-ECS state (stockpiles, research, villages) into the hash so the
    // reproducibility gate covers the whole sim, not just entities.
    stateHash: hashState(world, { base: serializeGameState(state) }),
  }

  console.log('=== headless sim run ===')
  for (const [key, value] of Object.entries(result)) {
    console.log(`${key.padEnd(16)} ${Array.isArray(value) ? value.join(', ') : value}`)
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
