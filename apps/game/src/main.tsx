import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Renderer } from '@factory/engine/render'
import { entityCount } from '@factory/engine/core'
import { App } from './App.tsx'
import { statsStore } from './statsStore.ts'
import { buildStore, type BuildItem } from './buildStore.ts'
import { installPlacement } from './placement.ts'
import { createSim, type ClientPrototype } from './sim.ts'
import { beltMoveAlpha } from './gameLogic.ts'
import './styles.css'

/** Read a numeric prototype field, falling back when absent/ill-typed. */
function num(proto: ClientPrototype, key: string, fallback: number): number {
  const v = proto[key]
  return typeof v === 'number' ? v : fallback
}

/** Map a prototype's `type` to a build-bar tool kind, or null if it isn't placeable. */
function toolKind(type: string): { kind: BuildItem['kind']; port?: 'input' | 'output' } | null {
  switch (type) {
    case 'building':
      return { kind: 'building' }
    case 'belt':
      return { kind: 'belt' }
    case 'splitter':
      return { kind: 'splitter' }
    case 'producer':
      return { kind: 'producer' }
    case 'output':
      return { kind: 'port', port: 'output' }
    case 'input':
      return { kind: 'port', port: 'input' }
    default:
      return null
  }
}

/** Map the placeable prototypes (buildings, belts, input/output ports) to build-bar tools. */
function toBuildItems(prototypes: readonly ClientPrototype[]): BuildItem[] {
  const items: BuildItem[] = []
  for (const p of prototypes) {
    const tool = toolKind(p.type)
    if (!tool) continue
    const size = (p.size ?? {}) as { w?: number; h?: number }
    items.push({
      id: p.id,
      name: typeof p.name === 'string' ? p.name : p.id,
      kind: tool.kind,
      ...(tool.port ? { port: tool.port } : {}),
      w: typeof size.w === 'number' ? size.w : 1,
      h: typeof size.h === 'number' ? size.h : 1,
      color: num(p, 'color', 0xffffff),
      itemColor: num(p, 'itemColor', 0xffffff),
      spawnEvery: num(p, 'spawnEvery', 20),
      moveEvery: num(p, 'moveEvery', 1),
      produceEvery: num(p, 'produceEvery', 30),
      storage: num(p, 'storage', 100),
    })
  }
  return items
}

/** Ask the Electron main process to load /content through the mod loader. */
async function loadContent(): Promise<{
  prototypes: ClientPrototype[]
  mods: string
}> {
  const bridge = window.factory
  if (!bridge) {
    // Plain-browser fallback (e.g. `vite` without Electron): no content, just grid.
    console.warn('No Electron bridge — running with an empty prototype set.')
    return { prototypes: [], mods: '(no bridge)' }
  }
  const loaded = await bridge.loadContent()
  return {
    prototypes: loaded.prototypes,
    mods: loaded.mods.map((m) => `${m.id}@${m.version}`).join(', '),
  }
}

async function boot(): Promise<void> {
  // React overlay.
  const overlay = document.getElementById('overlay')!
  createRoot(overlay).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )

  const { prototypes, mods } = await loadContent()
  const { world, scheduler, state } = createSim(prototypes)
  buildStore.setItems(toBuildItems(prototypes))

  const canvas = document.getElementById('stage') as HTMLCanvasElement
  const renderer = await Renderer.create({
    canvas,
    width: globalThis.innerWidth,
    height: globalThis.innerHeight,
  })
  globalThis.addEventListener('resize', () => {
    renderer.resize(globalThis.innerWidth, globalThis.innerHeight)
  })
  installPlacement(renderer, world)

  // Fixed-tick sim driven by real frame time; render interpolates with `alpha`.
  // Render is capped to 60fps; the sim stays decoupled via the scheduler.
  const minFrameMs = 1000 / 60
  let last = performance.now()
  let lastFrameAt = last
  let lastStatsAt = 0
  let frames = 0
  let fps = 0

  const frame = (now: number): void => {
    // Skip this rAF callback if we're ahead of the 60fps budget (high-refresh displays).
    if (now - lastFrameAt < minFrameMs) {
      requestAnimationFrame(frame)
      return
    }
    lastFrameAt = now

    const deltaMs = now - last
    last = now
    frames += 1

    // Belts step a whole tile per move-cycle; interpolate across the cycle (not the tick)
    // so items glide one tile at a time instead of teleporting on the move tick.
    const subTickAlpha = scheduler.advance(world, deltaMs)
    renderer.render(world, beltMoveAlpha(state, subTickAlpha))

    // Throttle React updates to ~4 Hz so the overlay never gates the frame rate.
    if (now - lastStatsAt > 250) {
      fps = Math.round((frames * 1000) / (now - lastStatsAt))
      frames = 0
      lastStatsAt = now
      statsStore.set({
        tick: world.tick,
        entities: entityCount(world),
        prototypes: prototypes.length,
        mods,
        fps,
      })
    }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

void boot()
