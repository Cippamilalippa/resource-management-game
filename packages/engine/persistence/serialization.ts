import { createGameWorld, spawnEntity, renderableEntities, type GameWorld } from '../core/index.ts'

/**
 * Deterministic (de)serialization of sim state. The wire format is intentionally
 * plain and stable: same world -> byte-identical snapshot, which is what makes the
 * reproducibility test (and future save/load + netcode) possible.
 *
 * This pass serializes the starter components only; richer components get added to
 * the snapshot as they are introduced.
 */
export const SNAPSHOT_VERSION = 1

export interface EntitySnapshot {
  readonly x: number
  readonly y: number
  readonly sprite: number
  readonly color: number
  readonly width: number
  readonly height: number
}

export interface WorldSnapshot {
  readonly version: number
  readonly seed: number
  readonly tick: number
  readonly rngState: number
  /** Entities sorted by (x, y, sprite) for a canonical, order-independent form. */
  readonly entities: readonly EntitySnapshot[]
  /**
   * Opaque, JSON-safe per-mod state, keyed by mod id. The engine stays game-agnostic: it
   * only carries and hashes this blob, never interprets it. Each mod owns the shape under
   * its own key (the base game serializes its `GameState` here), so nothing sim-critical
   * that lives outside the ECS is dropped from a save. Keys are sorted for a canonical form.
   */
  readonly modState: Readonly<Record<string, unknown>>
}

/**
 * Capture a canonical snapshot of the world's sim state. `modState` is an opaque per-mod
 * blob the engine carries verbatim (see {@link WorldSnapshot.modState}); callers that hold
 * no mod state pass nothing.
 */
export function serialize(gw: GameWorld, modState: Record<string, unknown> = {}): WorldSnapshot {
  const { Position, Renderable } = gw.components
  const ents = renderableEntities(gw)

  const entities: EntitySnapshot[] = []
  for (let i = 0; i < ents.length; i++) {
    const eid = ents[i]!
    entities.push({
      x: Position.x[eid]!,
      y: Position.y[eid]!,
      sprite: Renderable.sprite[eid]!,
      color: Renderable.color[eid]!,
      width: Renderable.width[eid]!,
      height: Renderable.height[eid]!,
    })
  }

  // Canonical ordering so the snapshot does not depend on entity-id allocation.
  entities.sort((a, b) => a.x - b.x || a.y - b.y || a.sprite - b.sprite || a.color - b.color)

  return {
    version: SNAPSHOT_VERSION,
    seed: gw.seed,
    tick: gw.tick,
    rngState: gw.rng.getState(),
    entities,
    // Re-key in sorted order so two worlds with the same mod state hash identically
    // regardless of the insertion order the host handed us.
    modState: canonicalizeModState(modState),
  }
}

/** Rebuild a plain object with its top-level keys sorted, for a canonical, hash-stable form. */
function canonicalizeModState(modState: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(modState).sort()) out[key] = modState[key]
  return out
}

/** Rebuild a world from a snapshot. Inverse of {@link serialize}. */
export function deserialize(snapshot: WorldSnapshot): GameWorld {
  if (snapshot.version !== SNAPSHOT_VERSION) {
    throw new Error(
      `Unsupported snapshot version ${snapshot.version} (expected ${SNAPSHOT_VERSION})`,
    )
  }
  const gw = createGameWorld(snapshot.seed)
  gw.tick = snapshot.tick
  gw.rng.setState(snapshot.rngState)
  for (const e of snapshot.entities) {
    spawnEntity(gw, {
      pos: { x: e.x, y: e.y },
      sprite: e.sprite,
      color: e.color,
      width: e.width,
      height: e.height,
    })
  }
  return gw
}
