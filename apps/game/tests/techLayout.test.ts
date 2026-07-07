import { describe, it, expect } from 'vitest'
import {
  layoutTechTree,
  prereqChain,
  TECH_LAYOUT_METRICS,
  type TechLayoutNode,
} from '../src/techLayout.ts'

/** Shorthand node builder. */
function n(id: string, ...prereqs: string[]): TechLayoutNode {
  return { id, prereqs }
}

/** The base game's 10-tech DAG (mods/base/prototypes/technologies.json), used as a real fixture. */
const BASE_TREE: TechLayoutNode[] = [
  n('foundry'),
  n('oil', 'foundry'),
  n('electronics', 'foundry'),
  n('metallurgy', 'foundry'),
  n('composites', 'oil', 'metallurgy'),
  n('avionics', 'electronics'),
  n('propulsion', 'metallurgy', 'composites'),
  n('jet', 'propulsion', 'avionics'),
  n('rocketry', 'propulsion', 'avionics'),
  n('orbital', 'rocketry', 'jet'),
]

describe('layoutTechTree — layering', () => {
  it('assigns each tech the longest-path depth from a root', () => {
    const layout = layoutTechTree(BASE_TREE)
    const layerOf = (id: string): number => layout.byId.get(id)!.layer
    expect(layerOf('foundry')).toBe(0)
    expect(layerOf('oil')).toBe(1)
    expect(layerOf('electronics')).toBe(1)
    expect(layerOf('metallurgy')).toBe(1)
    expect(layerOf('composites')).toBe(2)
    expect(layerOf('avionics')).toBe(2)
    // propulsion depends on composites (layer 2), so it must sit at 3 even though
    // metallurgy alone would allow 2 — layering is by the LONGEST path.
    expect(layerOf('propulsion')).toBe(3)
    expect(layerOf('jet')).toBe(4)
    expect(layerOf('rocketry')).toBe(4)
    expect(layerOf('orbital')).toBe(5)
  })

  it('always places a tech strictly right of every prerequisite', () => {
    const layout = layoutTechTree(BASE_TREE)
    for (const e of layout.edges) {
      expect(layout.byId.get(e.to)!.layer).toBeGreaterThan(layout.byId.get(e.from)!.layer)
    }
  })

  it('emits one edge per known prerequisite', () => {
    const layout = layoutTechTree(BASE_TREE)
    expect(layout.edges).toHaveLength(14)
    expect(layout.edges).toContainEqual({ from: 'foundry', to: 'oil' })
    expect(layout.edges).toContainEqual({ from: 'jet', to: 'orbital' })
  })

  it('ignores prerequisites naming an unknown tech', () => {
    const layout = layoutTechTree([n('a'), n('b', 'a', 'ghost')])
    expect(layout.byId.get('b')!.layer).toBe(1)
    expect(layout.edges).toEqual([{ from: 'a', to: 'b' }])
  })

  it('terminates on a prerequisite cycle and still places every node', () => {
    const layout = layoutTechTree([n('root'), n('x', 'y', 'root'), n('y', 'x')])
    expect(layout.nodes).toHaveLength(3)
    // Cycle members park after the resolved tree, in input order.
    expect(layout.byId.get('root')!.layer).toBe(0)
    expect(layout.byId.get('x')!.layer).toBe(1)
    expect(layout.byId.get('y')!.layer).toBe(1)
    expect(layout.byId.get('x')!.row).not.toBe(layout.byId.get('y')!.row)
  })

  it('handles an empty tree', () => {
    const layout = layoutTechTree([])
    expect(layout.nodes).toEqual([])
    expect(layout.width).toBe(0)
    expect(layout.height).toBe(0)
  })
})

describe('layoutTechTree — row ordering (barycenter)', () => {
  it('is deterministic: the same input yields the identical layout', () => {
    const a = layoutTechTree(BASE_TREE)
    const b = layoutTechTree(BASE_TREE)
    expect(b).toEqual(a)
  })

  it('unwinds a crossing the input order would cause', () => {
    // Input lists c (child of b) before d (child of a): naive order draws an X.
    const layout = layoutTechTree([n('a'), n('b'), n('c', 'b'), n('d', 'a')])
    const rowOf = (id: string): number => layout.byId.get(id)!.row
    // After the barycenter pass the children align with their parents: a↔d, b↔c.
    expect(rowOf('d')).toBe(rowOf('a'))
    expect(rowOf('c')).toBe(rowOf('b'))
  })

  it('gives every node in a layer a distinct row', () => {
    const layout = layoutTechTree(BASE_TREE)
    const seen = new Set<string>()
    for (const node of layout.nodes) {
      const slot = `${node.layer}:${node.row}`
      expect(seen.has(slot)).toBe(false)
      seen.add(slot)
    }
  })
})

describe('layoutTechTree — pixel placement', () => {
  it('never overlaps two cards', () => {
    const { nodeW, nodeH } = TECH_LAYOUT_METRICS
    const layout = layoutTechTree(BASE_TREE)
    for (let i = 0; i < layout.nodes.length; i++) {
      for (let j = i + 1; j < layout.nodes.length; j++) {
        const a = layout.nodes[i]!
        const b = layout.nodes[j]!
        const separated =
          a.x + nodeW <= b.x || b.x + nodeW <= a.x || a.y + nodeH <= b.y || b.y + nodeH <= a.y
        expect(separated, `${a.id} overlaps ${b.id}`).toBe(true)
      }
    }
  })

  it('sizes the canvas to contain every card', () => {
    const { nodeW, nodeH } = TECH_LAYOUT_METRICS
    const layout = layoutTechTree(BASE_TREE)
    for (const node of layout.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0)
      expect(node.y).toBeGreaterThanOrEqual(0)
      expect(node.x + nodeW).toBeLessThanOrEqual(layout.width)
      expect(node.y + nodeH).toBeLessThanOrEqual(layout.height)
    }
  })

  it('respects custom metrics', () => {
    const layout = layoutTechTree([n('a'), n('b', 'a')], {
      nodeW: 10,
      nodeH: 5,
      gapX: 4,
      gapY: 2,
    })
    expect(layout.byId.get('b')!.x).toBe(14)
    expect(layout.width).toBe(24)
    expect(layout.height).toBe(5)
  })
})

describe('prereqChain', () => {
  it('returns the tech plus its transitive prerequisites', () => {
    const chain = prereqChain('orbital', BASE_TREE)
    expect(chain).toEqual(
      new Set([
        'orbital',
        'rocketry',
        'jet',
        'propulsion',
        'avionics',
        'composites',
        'metallurgy',
        'oil',
        'electronics',
        'foundry',
      ]),
    )
  })

  it('is just the tech itself for a root', () => {
    expect(prereqChain('foundry', BASE_TREE)).toEqual(new Set(['foundry']))
  })

  it('ignores unknown ids and terminates on cycles', () => {
    expect(prereqChain('b', [n('a', 'b'), n('b', 'a', 'ghost')])).toEqual(new Set(['a', 'b']))
    expect(prereqChain('missing', BASE_TREE)).toEqual(new Set())
  })
})
