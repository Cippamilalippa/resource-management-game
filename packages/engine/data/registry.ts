import { z } from 'zod'

/**
 * Base prototype shape. A prototype is the immutable "blueprint" for a thing the
 * game can have (an item, a building, a recipe…). The engine only mandates an `id`
 * and a `type`; everything else is content-defined and passes through untouched,
 * because the engine must not hardcode any game concept.
 */
export const basePrototypeSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
  })
  .loose()

export type Prototype = z.infer<typeof basePrototypeSchema> & Record<string, unknown>

/** Error thrown when a prototype fails validation or violates a registry rule. */
export class PrototypeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PrototypeError'
  }
}

/**
 * In-memory registry of prototypes, keyed by string id. Mods and the base game
 * register here through the mod loader; sim/render code looks things up by id.
 * Validation happens at registration so bad data fails loud and early.
 */
export class PrototypeRegistry {
  #protos = new Map<string, Prototype>()
  readonly #schema: z.ZodType<{ id: string; type: string }>

  constructor(schema: z.ZodType<{ id: string; type: string }> = basePrototypeSchema) {
    this.#schema = schema
  }

  /** Validate and register a prototype. Throws on invalid data or duplicate id. */
  register(raw: unknown): Prototype {
    const result = this.#schema.safeParse(raw)
    if (!result.success) {
      throw new PrototypeError(
        `Invalid prototype: ${result.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
      )
    }
    const proto = result.data as Prototype
    if (this.#protos.has(proto.id)) {
      throw new PrototypeError(`Duplicate prototype id: "${proto.id}"`)
    }
    this.#protos.set(proto.id, proto)
    return proto
  }

  /** Look up a prototype, or undefined if absent. */
  get(id: string): Prototype | undefined {
    return this.#protos.get(id)
  }

  /** Look up a prototype, throwing if absent. */
  require(id: string): Prototype {
    const proto = this.#protos.get(id)
    if (!proto) {
      throw new PrototypeError(`Unknown prototype id: "${id}"`)
    }
    return proto
  }

  has(id: string): boolean {
    return this.#protos.has(id)
  }

  /** All registered prototypes (insertion order). */
  list(): readonly Prototype[] {
    return [...this.#protos.values()]
  }

  /** All prototypes of a given `type`. */
  listByType(type: string): readonly Prototype[] {
    return this.list().filter((p) => p.type === type)
  }

  get size(): number {
    return this.#protos.size
  }

  clear(): void {
    this.#protos.clear()
  }
}
