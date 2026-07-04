import {
  spawnEntity,
  despawnEntity,
  setRenderActive,
  type GameWorld,
  type System,
  type SpawnOptions,
} from '../core/index.ts'
import type { Prototype, PrototypeRegistry } from '../data/index.ts'

/**
 * The STABLE MOD API SURFACE.
 *
 * This is the entire contract a script (whether shipped in /content as "mod zero"
 * or by a third party in /mods) is given. The base game must reach the engine ONLY
 * through this surface — never via private engine internals — so that whatever the
 * base game can do, a modder can too.
 *
 * The sandbox that actually executes mod scripts is OUT OF SCOPE for this pass;
 * here we only nail down the shape so it can stay backwards-compatible later.
 */
export interface ModApi {
  /** Identity of the mod this API instance belongs to. */
  readonly modId: string

  /** Register a prototype (item/building/recipe/…). Validated on registration. */
  registerPrototype(raw: unknown): Prototype

  /** Look up an already-registered prototype by id. */
  getPrototype(id: string): Prototype | undefined

  /** Add a system to the fixed-tick schedule. */
  registerSystem(system: System): void

  /**
   * Spawn a renderable entity, returning its id. The sanctioned way for a mod to
   * create sim entities — a thin pass-through to the engine's generic spawn
   * primitive, so a mod never imports engine internals to do it.
   */
  spawn(opts: SpawnOptions): number

  /** Remove an entity the mod spawned (e.g. an item consumed off a belt). */
  despawn(eid: number): void

  /**
   * Set an entity's transient "active" render hint — a purely cosmetic one-way sim→render
   * signal (the renderer pulses active entities, e.g. a crafter mid-recipe). It is never
   * serialized or hashed, so toggling it can never affect determinism or save compatibility;
   * a load simply re-derives it on the next tick. Safe to call every tick.
   */
  setActive(eid: number, on: boolean): void

  /** Subscribe to an engine/game event. Returns an unsubscribe function. */
  on(event: string, listener: (payload: unknown) => void): () => void

  /**
   * Emit an event to the world's bus (symmetric with {@link on}). A mod uses this
   * to hand the host a read-only handle to its own state (e.g. a `ready` event),
   * keeping the sim→render flow one-way.
   */
  emit(event: string, payload: unknown): void

  /** Namespaced logging so mod output is attributable. */
  log(...args: unknown[]): void

  /**
   * Next float in [0, 1) from the world's seeded RNG. The sanctioned source of randomness
   * for a mod — a mod must never call `Math.random` (that would break determinism, and hence
   * save/load). Advances the shared RNG stream, so it stays reproducible for a given seed.
   */
  random(): number

  /**
   * Integer in [min, max] inclusive from the world's seeded RNG (see {@link random}). Convenience
   * over {@link random} for the common grid/layout case (e.g. jittering a scene's tile positions).
   */
  randomInt(min: number, max: number): number
}

/** Everything the host must supply to build a {@link ModApi} for a mod. */
export interface ModApiHost {
  readonly registry: PrototypeRegistry
  readonly world: GameWorld
  /** Sink the host uses to collect systems contributed by mods. */
  addSystem(system: System): void
}

/**
 * Construct the mod API surface for a single mod. (No sandboxing yet — the loader
 * calls this directly. The signature is what matters and must remain stable.)
 */
export function createModApi(modId: string, host: ModApiHost): ModApi {
  return {
    modId,
    registerPrototype: (raw) => host.registry.register(raw),
    getPrototype: (id) => host.registry.get(id),
    registerSystem: (system) => host.addSystem(system),
    spawn: (opts) => spawnEntity(host.world, opts),
    despawn: (eid) => despawnEntity(host.world, eid),
    setActive: (eid, on) => setRenderActive(host.world, eid, on),
    on: (event, listener) => host.world.events.on(event, listener),
    emit: (event, payload) => host.world.events.emit(event, payload),
    log: (...args) => console.log(`[mod:${modId}]`, ...args),
    random: () => host.world.rng.next(),
    randomInt: (min, max) => host.world.rng.nextInt(min, max),
  }
}
