import { MAX_ENTITIES } from './constants.ts'

/**
 * Components are Structure-of-Arrays: one typed array per field, indexed by
 * entity id. This is the hot path — no per-entity objects are ever allocated.
 *
 * Stores are created per-world (rather than module-level singletons) so that
 * multiple worlds — e.g. two headless runs in one test process — stay isolated.
 */
export interface PositionStore {
  /** Current tile coordinate (integers only). */
  readonly x: Int32Array
  readonly y: Int32Array
  /** Coordinate at the start of the current tick — render interpolates x..prevX. */
  readonly prevX: Int32Array
  readonly prevY: Int32Array
}

export interface RenderableStore {
  /** Opaque sprite/shape id (engine draws a colored rect placeholder for now). */
  readonly sprite: Uint16Array
  /** Packed 0xRRGGBB color for the placeholder rectangle. */
  readonly color: Uint32Array
  /** Size of the placeholder in tiles. */
  readonly width: Uint16Array
  readonly height: Uint16Array
}

export interface Components {
  readonly Position: PositionStore
  readonly Renderable: RenderableStore
}

/** Allocate a fresh, isolated set of component stores for one world. */
export function createComponents(): Components {
  return {
    Position: {
      x: new Int32Array(MAX_ENTITIES),
      y: new Int32Array(MAX_ENTITIES),
      prevX: new Int32Array(MAX_ENTITIES),
      prevY: new Int32Array(MAX_ENTITIES),
    },
    Renderable: {
      sprite: new Uint16Array(MAX_ENTITIES),
      color: new Uint32Array(MAX_ENTITIES),
      width: new Uint16Array(MAX_ENTITIES),
      height: new Uint16Array(MAX_ENTITIES),
    },
  }
}
