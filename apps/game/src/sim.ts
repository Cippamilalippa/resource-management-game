import {
  createGameWorld,
  spawnEntity,
  Scheduler,
  counterSystem,
  type GameWorld,
} from '@factory/engine/core'

/** A prototype as delivered by the preload bridge. */
export interface ClientPrototype {
  id: string
  type: string
  [key: string]: unknown
}

export interface ClientSim {
  world: GameWorld
  scheduler: Scheduler
}

/**
 * Build the renderer-side sim from the prototypes the main process loaded through
 * the mod loader. Spawns the same placeholder entity set the headless runner uses,
 * so both views stay consistent.
 */
export function createSim(prototypes: readonly ClientPrototype[], seed = 1): ClientSim {
  const world = createGameWorld(seed)

  const buildings = prototypes.filter((p) => p.type === 'building')
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

  for (let i = 0; i < 16; i++) {
    spawnEntity(world, {
      pos: { x: world.rng.nextInt(-20, 20), y: world.rng.nextInt(-20, 20) },
      color: 0x4fa8ff,
    })
  }

  const scheduler = new Scheduler([counterSystem])
  return { world, scheduler }
}
