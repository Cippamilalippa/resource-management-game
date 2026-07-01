import type { GameWorld } from '../core/index.ts'
import { serialize, type WorldSnapshot } from './serialization.ts'

/**
 * FNV-1a 32-bit hash over a canonical JSON encoding of a snapshot. Used by the
 * headless runner and the determinism test: same seed + same ticks must yield the
 * same hash. Returned as an 8-char hex string.
 */
export function hashSnapshot(snapshot: WorldSnapshot): string {
  const json = JSON.stringify(snapshot)
  let h = 0x811c9dc5
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i)
    // 32-bit FNV prime multiply via Math.imul
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * Convenience: snapshot a live world and hash it. Pass a mod-state blob (see
 * {@link serialize}) to fold each mod's out-of-ECS state into the hash, so the
 * reproducibility guarantee covers stockpiles/research/villages, not just entities.
 */
export function hashState(gw: GameWorld, modState: Record<string, unknown> = {}): string {
  return hashSnapshot(serialize(gw, modState))
}
