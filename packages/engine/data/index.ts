/**
 * engine/data — prototype registry and runtime schema validation. The single
 * source of truth for "what kinds of things exist", populated entirely from
 * content/mods. Depends on nothing game-specific.
 */
export {
  PrototypeRegistry,
  PrototypeError,
  basePrototypeSchema,
  type Prototype,
} from './registry.ts'

export {
  topologicalOrder,
  assertAcyclic,
  validateReferences,
  type ReferenceRule,
} from './validate.ts'
