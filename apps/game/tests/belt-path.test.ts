import { describe, it, expect } from 'vitest'
import { projectBelt, projectBeltPath, type BeltLeg } from '../src/gameLogic.ts'

/**
 * Pure path-math for the L-shaped belt drag (improvement-plan item L2). `projectBeltPath` routes a
 * drag A→B along its dominant axis to a corner, then perpendicular to B — degenerating to the exact
 * straight run `projectBelt` produces when A and B are already aligned. These tests pin the corner
 * placement, leg directions, degenerate cases, the flip modifier, and that the corner tile is shared
 * by both legs but counted exactly once in the reported length. No sim, no DOM.
 */

/** Expand a leg to its inclusive list of tile coordinates. */
function legTiles(leg: BeltLeg): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = []
  for (let i = 0; i < leg.length; i++) out.push({ x: leg.ax + leg.dx * i, y: leg.ay + leg.dy * i })
  return out
}

/** Distinct tiles across every leg of a path, as `"x,y"` keys. */
function distinctTiles(legs: readonly BeltLeg[]): Set<string> {
  const set = new Set<string>()
  for (const leg of legs) for (const t of legTiles(leg)) set.add(`${t.x},${t.y}`)
  return set
}

describe('projectBeltPath', () => {
  it('routes a mostly-horizontal drag dominant-axis-first, cornering at (bx, ay)', () => {
    const path = projectBeltPath(0, 0, 5, 2)
    expect(path.corner).toEqual({ x: 5, y: 0 })
    expect(path.legs).toHaveLength(2)
    // Leg 0: horizontal A→corner; leg 1: vertical corner→B.
    expect(path.legs[0]).toMatchObject({ ax: 0, ay: 0, bx: 5, by: 0, dx: 1, dy: 0, length: 6 })
    expect(path.legs[1]).toMatchObject({ ax: 5, ay: 0, bx: 5, by: 2, dx: 0, dy: 1, length: 3 })
  })

  it('routes a mostly-vertical drag dominant-axis-first, cornering at (ax, by)', () => {
    const path = projectBeltPath(0, 0, 2, 5)
    expect(path.corner).toEqual({ x: 0, y: 5 })
    expect(path.legs[0]).toMatchObject({ dx: 0, dy: 1, length: 6 })
    expect(path.legs[1]).toMatchObject({ dx: 1, dy: 0, length: 3 })
  })

  it('follows negative deltas (leftward + upward) the same way', () => {
    const path = projectBeltPath(5, 5, 0, 3)
    expect(path.corner).toEqual({ x: 0, y: 5 })
    expect(path.legs[0]).toMatchObject({ ax: 5, ay: 5, bx: 0, by: 5, dx: -1, dy: 0, length: 6 })
    expect(path.legs[1]).toMatchObject({ ax: 0, ay: 5, bx: 0, by: 3, dx: 0, dy: -1, length: 3 })
  })

  it('shares the corner tile between the two legs but counts it once in length', () => {
    const path = projectBeltPath(0, 0, 5, 2)
    // Leg ends where the next leg begins — the corner tile.
    expect({ x: path.legs[0]!.bx, y: path.legs[0]!.by }).toEqual(path.corner)
    expect({ x: path.legs[1]!.ax, y: path.legs[1]!.ay }).toEqual(path.corner)
    // Distinct-tile count equals the reported length: no tile double-counted, corner shared once.
    const tiles = distinctTiles(path.legs)
    expect(tiles.size).toBe(path.length)
    expect(path.length).toBe(6 + 3 - 1) // leg0 + leg1 − shared corner
    // The corner appears in both legs' raw tile lists (proving it is genuinely shared/re-aimed).
    expect(legTiles(path.legs[0]!).some((t) => t.x === 5 && t.y === 0)).toBe(true)
    expect(legTiles(path.legs[1]!).some((t) => t.x === 5 && t.y === 0)).toBe(true)
  })

  it('degenerates an axis-aligned drag to a single straight leg (corner === B)', () => {
    for (const [ax, ay, bx, by] of [
      [0, 0, 5, 0], // horizontal
      [0, 0, 0, 4], // vertical
      [2, 2, -3, 2], // leftward
    ] as const) {
      const path = projectBeltPath(ax, ay, bx, by)
      expect(path.legs).toHaveLength(1)
      expect(path.corner).toEqual({ x: bx, y: by })
      // Identical to the legacy straight projection: same step and length.
      const straight = projectBelt(ax, ay, bx, by)
      expect(path.legs[0]!.dx).toBe(straight.dx)
      expect(path.legs[0]!.dy).toBe(straight.dy)
      expect(path.legs[0]!.length).toBe(straight.length)
      expect(path.length).toBe(straight.length)
    }
  })

  it('degenerates a single-tile drag to one length-1 leg', () => {
    const path = projectBeltPath(3, 3, 3, 3)
    expect(path.legs).toHaveLength(1)
    expect(path.corner).toEqual({ x: 3, y: 3 })
    expect(path.length).toBe(1)
  })

  it('flip swaps which axis the first leg follows', () => {
    const path = projectBeltPath(0, 0, 5, 2, true)
    // Without flip the first leg is horizontal (dominant); flipped, it goes vertical first.
    expect(path.corner).toEqual({ x: 0, y: 2 })
    expect(path.legs[0]).toMatchObject({ dx: 0, dy: 1, length: 3 })
    expect(path.legs[1]).toMatchObject({ dx: 1, dy: 0, length: 6 })
    // Same total path length either way — only the corner moves.
    expect(path.length).toBe(projectBeltPath(0, 0, 5, 2).length)
  })

  it('flip on an aligned drag is a no-op (still a single straight leg)', () => {
    const path = projectBeltPath(0, 0, 5, 0, true)
    expect(path.legs).toHaveLength(1)
    expect(path.corner).toEqual({ x: 5, y: 0 })
  })

  it('handles an exact diagonal (|dx| === |dy|): horizontal first by default', () => {
    const path = projectBeltPath(0, 0, 3, 3)
    expect(path.corner).toEqual({ x: 3, y: 0 })
    expect(path.legs[0]).toMatchObject({ dx: 1, dy: 0, length: 4 })
    expect(path.legs[1]).toMatchObject({ dx: 0, dy: 1, length: 4 })
    expect(path.length).toBe(7)
  })
})
