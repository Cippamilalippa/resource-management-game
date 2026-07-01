import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Renderer } from '@factory/engine/render'
import { entityCount } from '@factory/engine/core'
import { App } from './App.tsx'
import { statsStore } from './statsStore.ts'
import { buildStore, type BuildItem } from './buildStore.ts'
import { installPlacement } from './placement.ts'
import { createSim, type ClientPrototype } from './sim.ts'
import type { DiscoveredModInfo } from '../electron/preload.ts'
import { beltMoveAlpha, buildableSet, allTechIds } from './gameLogic.ts'
import { buildIconTextures } from './iconTextures.ts'
import './styles.css'

/** Read a numeric prototype field, falling back when absent/ill-typed. */
function num(proto: ClientPrototype, key: string, fallback: number): number {
  const v = proto[key]
  return typeof v === 'number' ? v : fallback
}

/** Map a prototype's `type` to a build-bar tool kind, or null if it isn't placeable. A
 * `crafter` is NOT directly placeable: crafters are placed via their recipes (see
 * {@link recipeItems}), which pick a matching crafter building. */
function toolKind(type: string): { kind: BuildItem['kind']; port?: 'input' | 'output' } | null {
  switch (type) {
    case 'building':
      return { kind: 'building' }
    case 'belt':
      return { kind: 'belt' }
    case 'splitter':
      return { kind: 'splitter' }
    case 'output':
      return { kind: 'port', port: 'output' }
    case 'input':
      return { kind: 'port', port: 'input' }
    default:
      return null
  }
}

/** A recipe input/output flow as authored: `{ item, amount }`. */
interface RecipeFlow {
  item?: string
  amount?: number
}

/**
 * Synthesize a 'producer'-kind build tool per recipe, paired with the first crafter building
 * whose `craftingCategories` include the recipe's `category` (the recipe owns the output,
 * timing and terrain gate; the building owns the footprint, colour, icon and speed). This is
 * how a recipe becomes placeable: selecting it drops a crafter of the matching category.
 */
function recipeItems(
  prototypes: readonly ClientPrototype[],
  colorOfItem: (id: unknown) => number,
): BuildItem[] {
  // category -> first crafter building that provides it.
  const crafterFor = new Map<string, ClientPrototype>()
  for (const p of prototypes) {
    if (p.type !== 'crafter') continue
    const cats = Array.isArray(p.craftingCategories) ? p.craftingCategories : []
    for (const c of cats) if (typeof c === 'string' && !crafterFor.has(c)) crafterFor.set(c, p)
  }

  const items: BuildItem[] = []
  for (const r of prototypes) {
    if (r.type !== 'recipe') continue
    const category = typeof r.category === 'string' ? r.category : ''
    const building = crafterFor.get(category)
    if (!building) continue // no crafter provides this category — not buildable
    const results = Array.isArray(r.results) ? (r.results as RecipeFlow[]) : []
    const ingredients = Array.isArray(r.ingredients) ? (r.ingredients as RecipeFlow[]) : []
    const first = results[0]
    if (!first || typeof first.item !== 'string') continue
    const toFlows = (list: RecipeFlow[]): { color: number; amount: number }[] =>
      list
        .filter((f): f is { item: string; amount?: number } => typeof f.item === 'string')
        .map((f) => ({
          color: colorOfItem(f.item),
          amount: typeof f.amount === 'number' ? f.amount : 1,
        }))
    const size = (building.size ?? {}) as { w?: number; h?: number }
    items.push({
      id: r.id,
      name: typeof building.name === 'string' ? building.name : building.id,
      kind: 'producer',
      ...(typeof building.icon === 'string' ? { icon: building.icon } : {}),
      w: typeof size.w === 'number' ? size.w : 1,
      h: typeof size.h === 'number' ? size.h : 1,
      color: num(building, 'color', 0xffffff),
      itemColor: colorOfItem(first.item),
      craftInputs: toFlows(ingredients),
      craftOutputs: toFlows(results),
      accepts: [],
      spawnEvery: 20,
      moveEvery: 1,
      produceEvery: num(r, 'time', 30),
      storage: num(building, 'storage', 100),
      ...(typeof r.requiresTerrain === 'string' ? { requiresTerrain: r.requiresTerrain } : {}),
    })
  }
  return items
}

/** Map the placeable prototypes (buildings, belts, ports) and recipes to build-bar tools. */
function toBuildItems(prototypes: readonly ClientPrototype[]): BuildItem[] {
  // Resource identity is the item's colour; build an id->colour lookup so a building's
  // `accepts` and a recipe's `results` (lists of item ids) resolve to the colours the sim
  // works in.
  const itemColors = new Map<string, number>()
  for (const p of prototypes) if (p.type === 'item') itemColors.set(p.id, num(p, 'color', 0xffffff))
  const colorOfItem = (id: unknown): number =>
    typeof id === 'string' ? (itemColors.get(id) ?? 0xffffff) : 0xffffff

  const items: BuildItem[] = []
  for (const p of prototypes) {
    const tool = toolKind(p.type)
    if (!tool) continue
    const size = (p.size ?? {}) as { w?: number; h?: number }
    const accepts = Array.isArray(p.accepts) ? p.accepts.map(colorOfItem) : []
    items.push({
      id: p.id,
      name: typeof p.name === 'string' ? p.name : p.id,
      kind: tool.kind,
      ...(tool.port ? { port: tool.port } : {}),
      ...(typeof p.icon === 'string' ? { icon: p.icon } : {}),
      w: typeof size.w === 'number' ? size.w : 1,
      h: typeof size.h === 'number' ? size.h : 1,
      color: num(p, 'color', 0xffffff),
      itemColor: num(p, 'itemColor', 0xffffff),
      accepts,
      spawnEvery: num(p, 'spawnEvery', 20),
      moveEvery: num(p, 'moveEvery', 1),
      produceEvery: num(p, 'produceEvery', 30),
      storage: num(p, 'storage', 100),
      ...(typeof p.requiresTerrain === 'string' ? { requiresTerrain: p.requiresTerrain } : {}),
    })
  }
  // Recipes become 'producer' tools, paired with a crafter building of a matching category.
  items.push(...recipeItems(prototypes, colorOfItem))
  return items
}

/** Ask the Electron main process to load /content through the mod loader. */
async function loadContent(): Promise<{
  prototypes: ClientPrototype[]
  discovered: DiscoveredModInfo[]
  mods: string
}> {
  const bridge = window.factory
  if (!bridge) {
    // Plain-browser fallback (e.g. `vite` without Electron): no content, just grid.
    console.warn('No Electron bridge — running with an empty prototype set.')
    return { prototypes: [], discovered: [], mods: '(no bridge)' }
  }
  const loaded = await bridge.loadContent()
  return {
    prototypes: loaded.prototypes,
    discovered: loaded.discovered,
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

  const { prototypes, discovered, mods } = await loadContent()
  const { world, scheduler, state, registry } = await createSim(prototypes, discovered)
  // Derive which recipes/buildings are buildable from the researched technologies. There is no
  // runtime research yet (author + gate only), so every authored tech is seeded as researched —
  // the gate machinery is live and one-way (content → UI), just not withholding anything yet.
  const buildable = buildableSet(prototypes, allTechIds(prototypes))
  const items = toBuildItems(prototypes).filter((i) => buildable.has(i.id))
  buildStore.setItems(items)

  const canvas = document.getElementById('stage') as HTMLCanvasElement
  const renderer = await Renderer.create({
    canvas,
    width: globalThis.innerWidth,
    height: globalThis.innerHeight,
  })
  // Stamp the build-bar glyph onto placed buildings/producers, keyed by their tile colour.
  renderer.setIcons(await buildIconTextures(items))
  globalThis.addEventListener('resize', () => {
    renderer.resize(globalThis.innerWidth, globalThis.innerHeight)
  })
  const inspect = installPlacement(renderer, world, state, registry)

  // Fixed-tick sim driven by real frame time; render interpolates with `alpha`.
  // Render is capped to 60fps; the sim stays decoupled via the scheduler.
  // Cap with a margin below the 60Hz refresh interval (16.67ms) so vsync jitter
  // doesn't reject genuine frames that arrive a hair early — dropping one forces a
  // wait for the next vsync, halving the rate and making the FPS readout wobble.
  // ~12.7ms still suppresses extra frames on 120/144Hz displays (8.3/6.9ms intervals).
  const minFrameMs = 1000 / 60 - 4
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
      // Refresh the inspector so a pinned/hovered object's live numbers stay current.
      inspect.refresh()
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
