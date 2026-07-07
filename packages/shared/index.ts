/**
 * @factory/shared — types and pure utilities shared by the engine and the apps.
 * Nothing in here may be game-specific.
 */

/** A coordinate on the integer tile grid. The sim never uses float positions. */
export interface GridCoord {
  readonly x: number
  readonly y: number
}

/** Clamp `value` into the inclusive range [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min
  if (value > max) return max
  return value
}

/**
 * Linear interpolation. Used by the render layer to interpolate between the two
 * most recent sim ticks — never by the sim itself.
 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Narrowing assertion helper for invariant checks. */
export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`)
  }
}

/** Branded id type so prototype ids are not confused with arbitrary strings. */
export type PrototypeId = string & { readonly __brand: 'PrototypeId' }

// The pure production-graph pricing math (the credit economy's price source; also used by the
// balance analyzer). Kept in its own module so the game host and balancer share one formula.
export * from './pricing.ts'
