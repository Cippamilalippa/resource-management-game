/**
 * Deterministic seeded PRNG (mulberry32). The sim must never call Math.random:
 * determinism is what protects save/load and any future multiplayer. The whole
 * RNG state is a single uint32, so it serializes trivially.
 */
export class SeededRng {
  #state: number

  constructor(seed: number) {
    // Force to uint32 so behaviour is identical regardless of how the seed was
    // produced.
    this.#state = seed >>> 0
  }

  /** Next float in [0, 1). */
  next(): number {
    // mulberry32
    this.#state = (this.#state + 0x6d2b79f5) >>> 0
    let t = this.#state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** Integer in [min, max] inclusive. */
  nextInt(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1))
  }

  /** Snapshot the internal state for serialization. */
  getState(): number {
    return this.#state >>> 0
  }

  /** Restore a previously snapshotted state. */
  setState(state: number): void {
    this.#state = state >>> 0
  }
}
