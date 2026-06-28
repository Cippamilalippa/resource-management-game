import { describe, it, expect } from 'vitest'
import { PrototypeRegistry } from '../data/index.ts'
import { resolveLoadOrder, loadMods, type DiscoveredMod } from '../modloader/index.ts'
import type { FileSource } from '../modloader/index.ts'

/** An in-memory FileSource so loader tests need no disk. */
function memSource(files: Record<string, string>): FileSource {
  return {
    readText: (p) => {
      const f = files[p]
      if (f === undefined) return Promise.reject(new Error(`no such file: ${p}`))
      return Promise.resolve(f)
    },
    exists: (p) => Promise.resolve(p in files),
  }
}

function mod(
  id: string,
  dependencies: Record<string, string>,
  prototypes: Record<string, string> = {},
): DiscoveredMod {
  return {
    manifest: {
      id,
      version: '1.0.0',
      dependencies,
      prototypes: Object.keys(prototypes),
      scripts: [],
    },
    source: memSource(prototypes),
  }
}

describe('mod loader', () => {
  it('orders mods after their dependencies', () => {
    const a = mod('a', { b: '*' })
    const b = mod('b', {})
    const order = resolveLoadOrder([a, b]).map((m) => m.manifest.id)
    expect(order).toEqual(['b', 'a'])
  })

  it('throws on a missing dependency', () => {
    expect(() => resolveLoadOrder([mod('a', { ghost: '*' })])).toThrow(/Missing mod dependency/)
  })

  it('throws on a dependency cycle', () => {
    expect(() => resolveLoadOrder([mod('a', { b: '*' }), mod('b', { a: '*' })])).toThrow(/cycle/)
  })

  it('merges prototypes from all mods into the registry', async () => {
    const base = mod('base', {}, { 'protos.json': JSON.stringify([{ id: 'x', type: 'item' }]) })
    const ext = mod('ext', { base: '*' }, { 'p.json': JSON.stringify({ id: 'y', type: 'item' }) })
    const reg = new PrototypeRegistry()
    const result = await loadMods([ext, base], reg)
    expect(result.prototypeCount).toBe(2)
    expect(result.order.map((m) => m.id)).toEqual(['base', 'ext'])
    expect(reg.has('x')).toBe(true)
    expect(reg.has('y')).toBe(true)
  })
})
