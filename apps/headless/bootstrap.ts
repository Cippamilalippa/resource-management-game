import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  createGameWorld,
  spawnEntity,
  Scheduler,
  counterSystem,
  type GameWorld,
} from '@factory/engine/core'
import { PrototypeRegistry } from '@factory/engine/data'
import { NodeFileSource, discoverAndLoad, type LoadResult } from '@factory/engine/modloader'

/** Absolute path to the repo's /content directory ("mod zero"). */
export function contentDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, '../../content')
}

export interface Sim {
  readonly world: GameWorld
  readonly registry: PrototypeRegistry
  readonly scheduler: Scheduler
  readonly load: LoadResult
}

/**
 * Build a fully wired sim from a seed: load /content through the mod loader, create
 * a deterministic world, and spawn a small placeholder entity set derived from the
 * loaded building prototypes. Shared by the headless runner and the tests.
 */
export async function bootstrapSim(seed: number, tickRate = 60): Promise<Sim> {
  const registry = new PrototypeRegistry()
  const source = new NodeFileSource(contentDir())
  const load = await discoverAndLoad([source], registry)

  const world = createGameWorld(seed)

  // Spawn one placeholder entity per building prototype, laid out deterministically.
  const buildings = registry.listByType('building')
  buildings.forEach((proto, i) => {
    const size = (proto.size as { w?: number; h?: number } | undefined) ?? {}
    const color = typeof proto.color === 'number' ? proto.color : 0xffffff
    spawnEntity(world, {
      pos: { x: (i % 8) * 3, y: Math.floor(i / 8) * 3 },
      color,
      width: size.w ?? 1,
      height: size.h ?? 1,
    })
  })

  // A handful of seeded-random extra entities to exercise the RNG path.
  for (let i = 0; i < 16; i++) {
    spawnEntity(world, {
      pos: { x: world.rng.nextInt(-20, 20), y: world.rng.nextInt(-20, 20) },
      color: 0x4fa8ff,
    })
  }

  const scheduler = new Scheduler([counterSystem], { tickRate })
  return { world, registry, scheduler, load }
}
