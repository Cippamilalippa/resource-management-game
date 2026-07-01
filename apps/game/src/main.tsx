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
import {
  beltMoveAlpha,
  buildableSet,
  techTypeOf,
  enqueueSetActiveResearch,
  RESEARCH_NONE,
} from './gameLogic.ts'
import { buildIconTextures, resourceIconTextures } from './iconTextures.ts'
import { setResources } from './resources.ts'
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

/**
 * Per-technology metadata the host owns: the sim's opaque integer id (see `techTypeOf`), the
 * research-pack `cost` to complete it, and its prerequisites. The sandboxed sim never sees a tech
 * string; the host maps between the two so the sim can track research purely as integers.
 */
interface TechMeta {
  readonly id: string
  readonly int: number
  readonly cost: number
  readonly prereqs: readonly string[]
}

/** Read every technology's { int id, pack cost, prerequisites } from the loaded prototypes. */
function techMetas(prototypes: readonly ClientPrototype[]): TechMeta[] {
  const metas: TechMeta[] = []
  for (const p of prototypes) {
    if (p.type !== 'technology') continue
    const prereqs = (Array.isArray(p.prerequisites) ? p.prerequisites : []).filter(
      (x): x is string => typeof x === 'string',
    )
    const costList = Array.isArray(p.cost) ? (p.cost as RecipeFlow[]) : []
    let cost = 0
    for (const c of costList) if (c && typeof c.amount === 'number') cost += c.amount
    metas.push({ id: p.id, int: techTypeOf(p.id), cost, prereqs })
  }
  return metas
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
      ...(p.researchLab === true ? { researchLab: true } : {}),
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

  // Live research → buildable set. The sim tracks completed technologies by opaque integer id
  // (it never sees a tech string); the host owns the string↔int map and the authored costs. Root
  // techs (no prerequisites) are researched from the start; the rest are earned by feeding a lab
  // research packs. As the sim completes techs, `researchedIds` grows and the build bar re-derives.
  const techs = techMetas(prototypes)
  const techIdByInt = new Map(techs.map((t) => [t.int, t.id] as const))
  const researchedIds = new Set(techs.filter((t) => t.prereqs.length === 0).map((t) => t.id))
  const allBuildItems = toBuildItems(prototypes)

  // Install the resource registry (colour → icon + name) and rasterize a glyph per resource
  // colour. Resources don't change with research, so this is built once and merged with the
  // per-research building overlays below.
  const resourceTextures = await resourceIconTextures(setResources(prototypes))

  const canvas = document.getElementById('stage') as HTMLCanvasElement
  const renderer = await Renderer.create({
    canvas,
    width: globalThis.innerWidth,
    height: globalThis.innerHeight,
  })
  // Re-derive the build bar (and its glyphs) from the current researched set. Called at boot and
  // again whenever research completes a tech and unlocks new buildings/recipes.
  const refreshBuildBar = async (): Promise<void> => {
    const buildable = buildableSet(prototypes, researchedIds)
    const items = allBuildItems.filter((i) => buildable.has(i.id))
    buildStore.setItems(items)
    // Stamp the build-bar glyph onto placed buildings/producers (keyed by their tile colour), and
    // the resource glyph onto every item riding a belt (keyed by its identity colour). Buildings go
    // last so a building colour wins over an item colour in the unlikely event the two collide.
    renderer.setIcons(new Map([...resourceTextures, ...(await buildIconTextures(items))]))
  }
  await refreshBuildBar()
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
      // Pull runtime tech completions into the researched set, and keep research self-driving
      // until the M4 research screen lands. The sim records completed techs as integer ids; map
      // them back to strings, and when research is idle auto-select the next tech whose
      // prerequisites are met (deterministic prototype order). Replaced by the M4 research UI.
      let grew = false
      for (let i = 0; i < state.research.completed.length; i++) {
        const id = techIdByInt.get(state.research.completed[i]!)
        if (id !== undefined && !researchedIds.has(id)) {
          researchedIds.add(id)
          grew = true
        }
      }
      if (grew) void refreshBuildBar()
      if (state.research.activeTech === RESEARCH_NONE) {
        const next = techs.find(
          (t) => !researchedIds.has(t.id) && t.prereqs.every((p) => researchedIds.has(p)),
        )
        if (next) enqueueSetActiveResearch(world, { tech: next.int, cost: next.cost })
      }
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
