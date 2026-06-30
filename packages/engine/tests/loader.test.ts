import { describe, it, expect } from 'vitest'
import { PrototypeRegistry } from '../data/index.ts'
import { createGameWorld, type System } from '../core/index.ts'
import type { ModApi, ModApiHost } from '../scripting/index.ts'
import {
  resolveLoadOrder,
  loadMods,
  runModScripts,
  type DiscoveredMod,
  type ScriptModule,
  type ScriptResolver,
} from '../modloader/index.ts'
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

/** A discovered mod that declares `scriptPaths` (source content is unused — scripts
 *  are produced by the injected resolver, not read off the source). */
function scriptMod(
  id: string,
  dependencies: Record<string, string>,
  scriptPaths: string[],
): DiscoveredMod {
  return {
    manifest: { id, version: '1.0.0', dependencies, prototypes: [], scripts: scriptPaths },
    source: memSource({}),
  }
}

describe('runModScripts', () => {
  function makeHost(): { host: ModApiHost; registry: PrototypeRegistry; systems: System[] } {
    const registry = new PrototypeRegistry()
    const systems: System[] = []
    const host: ModApiHost = {
      registry,
      world: createGameWorld(1),
      addSystem: (s) => systems.push(s),
    }
    return { host, registry, systems }
  }

  /** Build a resolver from a path -> module map. */
  function resolverFrom(modules: Record<string, ScriptModule>): ScriptResolver {
    return (_source, path) => {
      const m = modules[path]
      if (m === undefined) return Promise.reject(new Error(`no script module: ${path}`))
      return Promise.resolve(m)
    }
  }

  it('runs each mod script in dependency order with its own bound api', async () => {
    const seen: string[] = []
    const modules: Record<string, ScriptModule> = {
      'a.ts': { default: (api: ModApi) => void seen.push(api.modId) },
      'b.ts': { default: (api: ModApi) => void seen.push(api.modId) },
    }
    const a = scriptMod('a', { b: '*' }, ['a.ts'])
    const b = scriptMod('b', {}, ['b.ts'])
    const { host } = makeHost()
    const result = await runModScripts([a, b], host, resolverFrom(modules))
    expect(seen).toEqual(['b', 'a'])
    expect(result.scriptsRun).toBe(2)
    expect(result.order.map((m) => m.id)).toEqual(['b', 'a'])
  })

  it('lets a script register systems and prototypes through the api', async () => {
    const modules: Record<string, ScriptModule> = {
      'main.ts': {
        default: (api: ModApi) => {
          api.registerPrototype({ id: 'item.z', type: 'item' })
          api.registerSystem(() => {})
        },
      },
    }
    const { host, registry, systems } = makeHost()
    await runModScripts([scriptMod('base', {}, ['main.ts'])], host, resolverFrom(modules))
    expect(registry.has('item.z')).toBe(true)
    expect(systems).toHaveLength(1)
  })

  it('skips a module with no default export but still resolves it', async () => {
    const modules: Record<string, ScriptModule> = { 'noop.ts': {} }
    const { host } = makeHost()
    const result = await runModScripts(
      [scriptMod('base', {}, ['noop.ts'])],
      host,
      resolverFrom(modules),
    )
    expect(result.scriptsRun).toBe(0)
  })

  it('runs every script of a multi-script mod', async () => {
    const order: string[] = []
    const modules: Record<string, ScriptModule> = {
      'one.ts': { default: () => void order.push('one') },
      'two.ts': { default: () => void order.push('two') },
    }
    const { host } = makeHost()
    const result = await runModScripts(
      [scriptMod('base', {}, ['one.ts', 'two.ts'])],
      host,
      resolverFrom(modules),
    )
    expect(order).toEqual(['one', 'two'])
    expect(result.scriptsRun).toBe(2)
  })

  it('propagates an error thrown by a script', async () => {
    const modules: Record<string, ScriptModule> = {
      'boom.ts': {
        default: () => {
          throw new Error('script blew up')
        },
      },
    }
    const { host } = makeHost()
    await expect(
      runModScripts([scriptMod('base', {}, ['boom.ts'])], host, resolverFrom(modules)),
    ).rejects.toThrow(/script blew up/)
  })
})
