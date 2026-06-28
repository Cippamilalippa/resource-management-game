import { describe, it, expect } from 'vitest'
import {
  createGameWorld,
  spawnEntity,
  Scheduler,
  counterSystem,
  entityCount,
} from '../core/index.ts'
import {
  serialize,
  deserialize,
  hashState,
  hashSnapshot,
  SNAPSHOT_VERSION,
} from '../persistence/index.ts'

/** A world with a deterministic entity set, advanced a few hundred ticks. */
function populated(seed: number) {
  const gw = createGameWorld(seed)
  for (let i = 0; i < 40; i++) {
    spawnEntity(gw, {
      pos: { x: gw.rng.nextInt(-30, 30), y: gw.rng.nextInt(-30, 30) },
      color: gw.rng.nextInt(0, 0xffffff),
      width: gw.rng.nextInt(1, 2),
      height: gw.rng.nextInt(1, 2),
    })
  }
  new Scheduler([counterSystem]).runTicks(gw, 200)
  return gw
}

describe('persistence save/load round-trip', () => {
  it('serialize -> deserialize preserves entity count and state hash', () => {
    const gw = populated(5)
    const restored = deserialize(serialize(gw))
    expect(entityCount(restored)).toBe(entityCount(gw))
    expect(restored.seed).toBe(gw.seed)
    expect(restored.tick).toBe(gw.tick)
    expect(restored.rng.getState()).toBe(gw.rng.getState())
    expect(hashState(restored)).toBe(hashState(gw))
  })

  it('re-serializing a restored world yields a byte-identical snapshot', () => {
    const gw = populated(9)
    const snap1 = serialize(gw)
    const snap2 = serialize(deserialize(snap1))
    expect(snap2).toEqual(snap1)
    expect(hashSnapshot(snap2)).toBe(hashSnapshot(snap1))
  })

  it('rejects an unsupported snapshot version', () => {
    const snap = { ...serialize(populated(1)), version: SNAPSHOT_VERSION + 1 }
    expect(() => deserialize(snap)).toThrow(/version/)
  })
})
