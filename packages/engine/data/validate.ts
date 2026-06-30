import { PrototypeError, type Prototype, type PrototypeRegistry } from './registry.ts'

/**
 * Content-graph validation primitives. These are **game-agnostic**: they know nothing
 * about recipes, technologies, items or any game concept (that would violate the
 * engine's core invariant). A caller from the game/content layer describes its graph
 * by passing selector functions — how to read a node's id and the ids it depends on —
 * and the engine enforces structural rules over it.
 *
 * The topological kernel is the same algorithm the mod loader uses for mod
 * dependencies, lifted here so any content graph (tech prerequisites, item production
 * order, …) can reuse it instead of re-implementing cycle detection.
 */

/**
 * Order `nodes` so every node comes after the nodes it depends on (topological sort).
 *
 * Game-agnostic: `idOf` reads a node's id, `depsOf` reads the ids it depends on.
 * Throws {@link PrototypeError} on a dependency cycle (with the offending chain) and,
 * unless `onMissing` is `'ignore'`, on a dependency id that has no corresponding node.
 */
export function topologicalOrder<T>(
  nodes: readonly T[],
  idOf: (node: T) => string,
  depsOf: (node: T) => readonly string[],
  options: { onMissing?: 'throw' | 'ignore' } = {},
): T[] {
  const onMissing = options.onMissing ?? 'throw'

  const byId = new Map<string, T>()
  for (const node of nodes) {
    const id = idOf(node)
    if (byId.has(id)) {
      throw new PrototypeError(`Duplicate node id: "${id}"`)
    }
    byId.set(id, node)
  }

  const ordered: T[] = []
  const visited = new Set<string>()
  const inProgress = new Set<string>()

  const visit = (id: string, chain: readonly string[]): void => {
    if (visited.has(id)) return
    if (inProgress.has(id)) {
      throw new PrototypeError(`Dependency cycle: ${[...chain, id].join(' -> ')}`)
    }
    const node = byId.get(id)
    if (!node) {
      if (onMissing === 'ignore') return
      throw new PrototypeError(
        `Missing dependency: "${id}"${chain.length ? ` (required by ${chain.join(' -> ')})` : ''}`,
      )
    }
    inProgress.add(id)
    for (const dep of depsOf(node)) {
      visit(dep, [...chain, id])
    }
    inProgress.delete(id)
    visited.add(id)
    ordered.push(node)
  }

  for (const node of nodes) {
    visit(idOf(node), [])
  }
  return ordered
}

/**
 * Assert that the graph described by `idOf`/`depsOf` over `nodes` is acyclic and (by
 * default) references no missing node. Convenience wrapper over {@link topologicalOrder}
 * for callers that only care that the graph is well-formed, not the order.
 */
export function assertAcyclic<T>(
  nodes: readonly T[],
  idOf: (node: T) => string,
  depsOf: (node: T) => readonly string[],
  options: { onMissing?: 'throw' | 'ignore' } = {},
): void {
  topologicalOrder(nodes, idOf, depsOf, options)
}

/**
 * A reference-integrity rule: every prototype of `type` must have its referenced ids
 * resolve in the registry (and, if `expectType` is given, resolve to that type).
 *
 * `select` is game-defined — it pulls the referenced ids out of a prototype's
 * content-defined fields — so the engine never hardcodes a field name like
 * `ingredients` or `prerequisites`.
 */
export interface ReferenceRule {
  /** Only prototypes of this `type` are checked. */
  readonly type: string
  /** Pull the referenced ids out of a prototype. */
  readonly select: (proto: Prototype) => readonly string[]
  /** If set, each referenced prototype must exist and have this `type`. */
  readonly expectType?: string
  /** Noun used in error messages, e.g. `'ingredient'` (defaults to `'reference'`). */
  readonly label?: string
}

/**
 * Enforce a set of {@link ReferenceRule}s against the registry. Throws
 * {@link PrototypeError} on the first dangling or wrong-typed reference.
 */
export function validateReferences(
  registry: PrototypeRegistry,
  rules: readonly ReferenceRule[],
): void {
  for (const rule of rules) {
    const label = rule.label ?? 'reference'
    for (const proto of registry.listByType(rule.type)) {
      for (const refId of rule.select(proto)) {
        const target = registry.get(refId)
        if (!target) {
          throw new PrototypeError(`${proto.id}: ${label} "${refId}" does not exist`)
        }
        if (rule.expectType !== undefined && target.type !== rule.expectType) {
          throw new PrototypeError(
            `${proto.id}: ${label} "${refId}" must be a "${rule.expectType}", got "${target.type}"`,
          )
        }
      }
    }
  }
}
