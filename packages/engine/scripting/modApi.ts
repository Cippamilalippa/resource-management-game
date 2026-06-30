import {
  spawnEntity,
  despawnEntity,
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
    on: (event, listener) => host.world.events.on(event, listener),
    emit: (event, payload) => host.world.events.emit(event, payload),
    log: (...args) => console.log(`[mod:${modId}]`, ...args),
  }
}
