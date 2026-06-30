import { describe, it, expect } from 'vitest'
import { createGameWorld, entityCount, type System } from '../core/index.ts'
import { PrototypeRegistry } from '../data/index.ts'
import { createModApi, type ModApiHost } from '../scripting/index.ts'

/** A host wired to a fresh world + registry, collecting any systems a mod registers. */
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

describe('createModApi', () => {
  it('carries the mod id', () => {
    const { host } = makeHost()
    expect(createModApi('base', host).modId).toBe('base')
  })

  it('routes registerPrototype/getPrototype through the host registry', () => {
    const { host, registry } = makeHost()
    const api = createModApi('base', host)
    api.registerPrototype({ id: 'item.z', type: 'item' })
    expect(registry.has('item.z')).toBe(true)
    expect(api.getPrototype('item.z')?.id).toBe('item.z')
    expect(api.getPrototype('missing')).toBeUndefined()
  })

  it('routes registerSystem to the host sink', () => {
    const { host, systems } = makeHost()
    const api = createModApi('base', host)
    const sys: System = () => {}
    api.registerSystem(sys)
    expect(systems).toEqual([sys])
  })

  it('spawn adds a renderable entity and returns its id', () => {
    const { host } = makeHost()
    const api = createModApi('base', host)
    const before = entityCount(host.world)
    const eid = api.spawn({ pos: { x: 3, y: -4 }, color: 0x123456, width: 2, height: 1 })
    expect(typeof eid).toBe('number')
    expect(entityCount(host.world)).toBe(before + 1)
    const { Position, Renderable } = host.world.components
    expect(Position.x[eid]).toBe(3)
    expect(Position.y[eid]).toBe(-4)
    expect(Renderable.color[eid]).toBe(0x123456)
    expect(Renderable.width[eid]).toBe(2)
  })

  it('despawn removes an entity the mod spawned', () => {
    const { host } = makeHost()
    const api = createModApi('base', host)
    const eid = api.spawn({ pos: { x: 0, y: 0 } })
    const after = entityCount(host.world)
    api.despawn(eid)
    expect(entityCount(host.world)).toBe(after - 1)
  })

  it('emit dispatches to world-bus listeners, and on() subscribes', () => {
    const { host } = makeHost()
    const api = createModApi('base', host)
    const seen: unknown[] = []
    const off = api.on('base:ready', (p) => seen.push(p))
    api.emit('base:ready', { ok: true })
    expect(seen).toEqual([{ ok: true }])
    // The unsubscribe handle from on() stops further delivery.
    off()
    api.emit('base:ready', { ok: false })
    expect(seen).toEqual([{ ok: true }])
  })

  it('on() observes events emitted directly on the same world bus', () => {
    const { host } = makeHost()
    const api = createModApi('base', host)
    const seen: unknown[] = []
    api.on('evt', (p) => seen.push(p))
    host.world.events.emit('evt', 42)
    expect(seen).toEqual([42])
  })
})
