/**
 * engine/persistence — deterministic (de)serialization of sim state plus state
 * hashing. Depends on core only; never on render.
 */
export {
  serialize,
  deserialize,
  SNAPSHOT_VERSION,
  type WorldSnapshot,
  type EntitySnapshot,
} from './serialization.ts'
export { hashSnapshot, hashState } from './hash.ts'
