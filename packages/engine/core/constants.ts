/**
 * Hard limits and defaults for the sim. These bound the typed-array component
 * stores; sizing for "thousands of simultaneous units" with headroom.
 */

/** Maximum number of live entities. Component stores are sized to this. */
export const MAX_ENTITIES = 100_000

/** Logical simulation rate. The sim advances in fixed steps of 1/TICK_RATE s. */
export const DEFAULT_TICK_RATE = 60

/** Pixels per tile in world space (render-side default; not a sim concept). */
export const TILE_SIZE = 32
