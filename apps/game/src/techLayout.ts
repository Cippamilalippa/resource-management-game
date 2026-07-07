/**
 * Pure layered-DAG layout for the research tree (U3). Turns the technologies' prerequisite graph
 * into node positions + edge lists the research panel renders as a real graph: layers by longest
 * path from a root (so a tech always sits right of every prerequisite), a small barycenter pass to
 * reduce edge crossings within each layer, and pixel positions on a fixed card grid. Pure data →
 * data with no DOM/React/sim dependencies, so it's unit-tested in `apps/game/tests/`.
 */

/** The slice of a technology the layout needs: its id and prerequisite tech ids. */
export interface TechLayoutNode {
  readonly id: string
  readonly prereqs: readonly string[]
}

/** Card + spacing metrics (px) the positions are computed on. */
export interface TechLayoutMetrics {
  readonly nodeW: number
  readonly nodeH: number
  /** Horizontal gap between layers (edge routing space). */
  readonly gapX: number
  /** Vertical gap between cards in a layer. */
  readonly gapY: number
}

/** Default card metrics, shared with the renderer so tests and view agree. */
export const TECH_LAYOUT_METRICS: TechLayoutMetrics = { nodeW: 148, nodeH: 88, gapX: 40, gapY: 14 }

/** One positioned node: grid coordinates (layer/row) and the card's top-left pixel corner. */
export interface PlacedTechNode {
  readonly id: string
  /** Longest-path depth from a root (roots are layer 0). */
  readonly layer: number
  /** Vertical slot within the layer after crossing reduction. */
  readonly row: number
  readonly x: number
  readonly y: number
}

/** One prerequisite edge, drawn from the prereq's card to the dependent tech's card. */
export interface TechEdge {
  readonly from: string
  readonly to: string
}

/** The computed graph: positioned nodes, edges, and the overall canvas size. */
export interface TechLayout {
  readonly nodes: readonly PlacedTechNode[]
  readonly byId: ReadonlyMap<string, PlacedTechNode>
  readonly edges: readonly TechEdge[]
  readonly width: number
  readonly height: number
}

/**
 * Assign each node its layer: the longest prerequisite path from any root. Kahn's algorithm over
 * the (known-id) prerequisite edges; edges naming an unknown tech are ignored so a modded tree
 * with a dangling prereq still lays out. Nodes trapped in a prerequisite cycle (invalid data, but
 * the layout must not hang) are appended after the resolved layers in input order.
 */
function assignLayers(nodes: readonly TechLayoutNode[]): Map<string, number> {
  const known = new Set(nodes.map((n) => n.id))
  const layer = new Map<string, number>()
  const remaining = new Map<string, number>() // unresolved (known) prereq count per node
  const dependents = new Map<string, string[]>() // prereq id → nodes waiting on it
  for (const n of nodes) {
    const prereqs = n.prereqs.filter((p) => known.has(p) && p !== n.id)
    remaining.set(n.id, prereqs.length)
    for (const p of prereqs) {
      const bucket = dependents.get(p)
      if (bucket) bucket.push(n.id)
      else dependents.set(p, [n.id])
    }
  }
  const prereqsOf = new Map(
    nodes.map((n) => [n.id, n.prereqs.filter((p) => known.has(p) && p !== n.id)] as const),
  )

  // Kahn's queue in input order for determinism.
  const queue: string[] = nodes.filter((n) => remaining.get(n.id) === 0).map((n) => n.id)
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head]!
    let depth = 0
    for (const p of prereqsOf.get(id) ?? []) depth = Math.max(depth, (layer.get(p) ?? 0) + 1)
    layer.set(id, depth)
    for (const d of dependents.get(id) ?? []) {
      const left = (remaining.get(d) ?? 0) - 1
      remaining.set(d, left)
      if (left === 0) queue.push(d)
    }
  }

  // Anything unresolved sits in a cycle: park it one layer past the resolved tree, input order.
  let maxLayer = -1
  for (const l of layer.values()) maxLayer = Math.max(maxLayer, l)
  for (const n of nodes) if (!layer.has(n.id)) layer.set(n.id, maxLayer + 1)
  return layer
}

/**
 * Order the nodes within each layer to reduce edge crossings: start from input order, then run a
 * fixed number of alternating barycenter sweeps (down: order by mean prereq row; up: by mean
 * dependent row). Sorting is stable and nodes without neighbours keep their current slot, so the
 * result is deterministic for a given input order.
 */
function orderRows(
  nodes: readonly TechLayoutNode[],
  layerOf: Map<string, number>,
): Map<string, number> {
  const known = new Set(nodes.map((n) => n.id))
  const layers: string[][] = []
  for (const n of nodes) {
    const l = layerOf.get(n.id)!
    while (layers.length <= l) layers.push([])
    layers[l]!.push(n.id)
  }
  const prereqsOf = new Map(
    nodes.map((n) => [n.id, n.prereqs.filter((p) => known.has(p) && p !== n.id)] as const),
  )
  const dependentsOf = new Map<string, string[]>()
  for (const n of nodes) {
    for (const p of prereqsOf.get(n.id) ?? []) {
      const bucket = dependentsOf.get(p)
      if (bucket) bucket.push(n.id)
      else dependentsOf.set(p, [n.id])
    }
  }

  const row = new Map<string, number>()
  const reindex = (ids: string[]): void => {
    for (let i = 0; i < ids.length; i++) row.set(ids[i]!, i)
  }
  for (const ids of layers) reindex(ids)

  /** Stable-sort one layer by the mean row of each node's neighbours (keep slot if none). */
  const sweep = (ids: string[], neighbours: (id: string) => readonly string[]): void => {
    const bary = new Map<string, number>()
    for (const id of ids) {
      const ns = neighbours(id)
      if (ns.length === 0) {
        bary.set(id, row.get(id)!)
        continue
      }
      let sum = 0
      for (const n of ns) sum += row.get(n)!
      bary.set(id, sum / ns.length)
    }
    ids.sort((a, b) => bary.get(a)! - bary.get(b)! || row.get(a)! - row.get(b)!)
    reindex(ids)
  }

  for (let pass = 0; pass < 2; pass++) {
    for (let l = 1; l < layers.length; l++) sweep(layers[l]!, (id) => prereqsOf.get(id) ?? []) // down: align to prereqs
    for (let l = layers.length - 2; l >= 0; l--)
      sweep(layers[l]!, (id) => dependentsOf.get(id) ?? []) // up: align to dependents
  }
  return row
}

/**
 * Lay out the technology DAG: layer by longest path from a root, order rows with a barycenter
 * pass, and place each card on a pixel grid (each layer vertically centred against the tallest
 * one). Deterministic for a given input order.
 */
export function layoutTechTree(
  nodes: readonly TechLayoutNode[],
  metrics: TechLayoutMetrics = TECH_LAYOUT_METRICS,
): TechLayout {
  const layerOf = assignLayers(nodes)
  const rowOf = orderRows(nodes, layerOf)

  const rowsPerLayer: number[] = []
  let layerCount = 0
  for (const n of nodes) {
    const l = layerOf.get(n.id)!
    layerCount = Math.max(layerCount, l + 1)
    rowsPerLayer[l] = (rowsPerLayer[l] ?? 0) + 1
  }
  let maxRows = 0
  for (let l = 0; l < layerCount; l++) maxRows = Math.max(maxRows, rowsPerLayer[l] ?? 0)

  const stepX = metrics.nodeW + metrics.gapX
  const stepY = metrics.nodeH + metrics.gapY
  const placed: PlacedTechNode[] = []
  const byId = new Map<string, PlacedTechNode>()
  for (const n of nodes) {
    const layer = layerOf.get(n.id)!
    const rowsHere = rowsPerLayer[layer] ?? 1
    // Centre this layer's column against the tallest layer, snapped to whole pixels.
    const offsetY = Math.round(((maxRows - rowsHere) * stepY) / 2)
    const row = rowOf.get(n.id)!
    const node: PlacedTechNode = {
      id: n.id,
      layer,
      row,
      x: layer * stepX,
      y: offsetY + row * stepY,
    }
    placed.push(node)
    byId.set(n.id, node)
  }

  const known = new Set(nodes.map((n) => n.id))
  const edges: TechEdge[] = []
  for (const n of nodes) {
    for (const p of n.prereqs) if (known.has(p) && p !== n.id) edges.push({ from: p, to: n.id })
  }

  return {
    nodes: placed,
    byId,
    edges,
    width: layerCount > 0 ? layerCount * metrics.nodeW + (layerCount - 1) * metrics.gapX : 0,
    height: maxRows > 0 ? maxRows * metrics.nodeH + (maxRows - 1) * metrics.gapY : 0,
  }
}

/**
 * The transitive prerequisite closure of a tech (the tech itself included) — the "chain" the graph
 * highlights while it is the active research. Unknown ids are ignored; cycles terminate.
 */
export function prereqChain(id: string, nodes: readonly TechLayoutNode[]): ReadonlySet<string> {
  const prereqsOf = new Map(nodes.map((n) => [n.id, n.prereqs] as const))
  const chain = new Set<string>()
  const stack = [id]
  while (stack.length > 0) {
    const cur = stack.pop()!
    if (chain.has(cur) || !prereqsOf.has(cur)) continue
    chain.add(cur)
    for (const p of prereqsOf.get(cur) ?? []) stack.push(p)
  }
  return chain
}
