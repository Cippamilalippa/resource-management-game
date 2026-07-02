import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Renderer } from '@factory/engine/render'
import { entityCount, type GameWorld, type Scheduler } from '@factory/engine/core'
import { SNAPSHOT_VERSION, type WorldSnapshot } from '@factory/engine/persistence'
import { App } from './App.tsx'
import { statsStore } from './statsStore.ts'
import { buildStore, type BuildItem } from './buildStore.ts'
import { installPlacement } from './placement.ts'
import { createSim, type ClientPrototype, type SimOrigin } from './sim.ts'
import { saveStore, type SaveController } from './saveStore.ts'
import type { InspectRegistry } from './inspect.ts'
import type { GameState } from './gameLogic.ts'
import type { DiscoveredModInfo, SaveMeta } from '../electron/preload.ts'
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
  /** Per-pack research cost as the sim consumes it: { pack colour, amount }. */
  readonly cost: readonly { color: number; amount: number }[]
  readonly prereqs: readonly string[]
}

/** Read every technology's { int id, per-pack cost, prerequisites } from the loaded prototypes. */
function techMetas(prototypes: readonly ClientPrototype[]): TechMeta[] {
  // The sim works in item colours, not ids; resolve each cost entry's item to its colour.
  const itemColors = new Map<string, number>()
  for (const p of prototypes) if (p.type === 'item') itemColors.set(p.id, num(p, 'color', 0xffffff))

  const metas: TechMeta[] = []
  for (const p of prototypes) {
    if (p.type !== 'technology') continue
    const prereqs = (Array.isArray(p.prerequisites) ? p.prerequisites : []).filter(
      (x): x is string => typeof x === 'string',
    )
    const costList = Array.isArray(p.cost) ? (p.cost as RecipeFlow[]) : []
    const cost: { color: number; amount: number }[] = []
    for (const c of costList) {
      if (c && typeof c.item === 'string' && typeof c.amount === 'number') {
        cost.push({ color: itemColors.get(c.item) ?? 0xffffff, amount: c.amount })
      }
    }
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

  // Session-invariant derived data (recomputed once, shared across new-game/load).
  // The sim tracks completed technologies by opaque integer id (it never sees a tech string); the
  // host owns the string↔int map and the authored costs. Root techs (no prerequisites) are
  // researched from the start; the rest are earned by feeding a lab research packs.
  const techs = techMetas(prototypes)
  const techIdByInt = new Map(techs.map((t) => [t.int, t.id] as const))
  const rootTechIds = techs.filter((t) => t.prereqs.length === 0).map((t) => t.id)
  const allBuildItems = toBuildItems(prototypes)

  // Derive the researched-string set from a research store's completed integer ids plus the always-
  // available root techs. Called when a session starts so a loaded save unlocks exactly what it had.
  const researchedFrom = (completed: readonly number[]): Set<string> => {
    const ids = new Set(rootTechIds)
    for (let i = 0; i < completed.length; i++) {
      const id = techIdByInt.get(completed[i]!)
      if (id !== undefined) ids.add(id)
    }
    return ids
  }

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
  globalThis.addEventListener('resize', () => {
    renderer.resize(globalThis.innerWidth, globalThis.innerHeight)
  })

  /**
   * The live sim the render loop drives. Swapped wholesale on new-game/load: a fresh
   * {@link createSim} builds a new world/scheduler/state, and placement is re-pointed at it (the
   * renderer keeps its callback slots, so re-installing just overwrites them — no double-binding).
   * The renderer reconciles the entity set each frame, so pointing it at a new world Just Works.
   */
  interface Session {
    world: GameWorld
    scheduler: Scheduler
    state: GameState
    registry: InspectRegistry
    inspect: { refresh: () => void }
    /** Researched tech ids for this session (grows as research completes). */
    researchedIds: Set<string>
    serialize: () => WorldSnapshot
  }
  let session: Session | null = null

  // Re-derive the build bar (and its glyphs) from the current session's researched set. Called when
  // a session starts and whenever research completes a tech and unlocks new buildings/recipes.
  const refreshBuildBar = async (): Promise<void> => {
    if (!session) return
    const buildable = buildableSet(prototypes, session.researchedIds)
    const items = allBuildItems.filter((i) => buildable.has(i.id))
    buildStore.setItems(items)
    // Stamp the build-bar glyph onto placed buildings/producers (keyed by their tile colour), and
    // the resource glyph onto every item riding a belt (keyed by its identity colour). Buildings go
    // last so a building colour wins over an item colour in the unlikely event the two collide.
    renderer.setIcons(new Map([...resourceTextures, ...(await buildIconTextures(items))]))
  }

  /** Build a fresh sim from an origin (new game or restored save) and make it the live session. */
  const startSession = async (origin: SimOrigin): Promise<void> => {
    const sim = await createSim(prototypes, discovered, origin)
    const inspect = installPlacement(renderer, sim.world, sim.state, sim.registry)
    session = {
      world: sim.world,
      scheduler: sim.scheduler,
      state: sim.state,
      registry: sim.registry,
      inspect,
      researchedIds: researchedFrom(sim.state.research.completed),
      serialize: sim.serialize,
    }
    await refreshBuildBar()
  }

  await startSession({ kind: 'new' })

  // ── Save/load controller ─────────────────────────────────────────────────────────────────────
  // The menu (React) drives this; every disk op reports progress back through saveStore. The bridge
  // is absent in a plain browser (no Electron) — the menu then shows an unavailable state.
  const bridge = window.factory
  let toastTimer: ReturnType<typeof setTimeout> | undefined
  const flashToast = (msg: string): void => {
    saveStore.set({ toast: msg })
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => saveStore.set({ toast: null }), 2200)
  }
  /** Run a disk op with the busy flag set, surfacing any failure as a sticky error. */
  const withBusy = async (fn: () => Promise<void>): Promise<void> => {
    saveStore.set({ busy: true, error: null })
    try {
      await fn()
    } catch (err) {
      saveStore.set({ error: err instanceof Error ? err.message : String(err) })
    } finally {
      saveStore.set({ busy: false })
    }
  }
  const refreshSaves = async (): Promise<void> => {
    if (!bridge) return
    saveStore.set({ saves: await bridge.listSaves() })
  }
  /** Restore a slot into a freshly built session and mark it active. */
  const loadMeta = async (meta: SaveMeta): Promise<void> => {
    if (!bridge) return
    // Reject a save from an incompatible engine version rather than crashing the restore.
    if (meta.snapshotVersion !== SNAPSHOT_VERSION) {
      throw new Error(
        `Save "${meta.name}" is version ${meta.snapshotVersion}; this build reads version ${SNAPSHOT_VERSION}.`,
      )
    }
    const payload = await bridge.loadGame(meta.id)
    await startSession({ kind: 'load', snapshot: payload.snapshot as WorldSnapshot })
    saveStore.set({ open: false, activeId: meta.id })
    flashToast(`Loaded "${meta.name}"`)
  }

  const controller: SaveController = {
    open: () => {
      saveStore.set({ open: true, error: null })
      void withBusy(refreshSaves)
    },
    close: () => saveStore.set({ open: false }),
    refresh: () => withBusy(refreshSaves),
    quickSave: () =>
      withBusy(async () => {
        if (!bridge || !session) return
        await bridge.saveGame({ kind: 'quick', snapshot: session.serialize() })
        await refreshSaves()
        flashToast('Quicksaved')
      }),
    quickLoad: () =>
      withBusy(async () => {
        if (!bridge) return
        const saves = await bridge.listSaves()
        const quick = saves.find((s) => s.kind === 'quick')
        if (!quick) {
          flashToast('No quicksave')
          return
        }
        await loadMeta(quick)
      }),
    saveNew: (name: string) =>
      withBusy(async () => {
        if (!bridge || !session) return
        const meta = await bridge.saveGame({ kind: 'manual', name, snapshot: session.serialize() })
        await refreshSaves()
        saveStore.set({ activeId: meta.id })
        flashToast(`Saved "${meta.name}"`)
      }),
    overwrite: (meta: SaveMeta) =>
      withBusy(async () => {
        if (!bridge || !session) return
        await bridge.saveGame({
          kind: 'manual',
          id: meta.id,
          name: meta.name,
          snapshot: session.serialize(),
        })
        await refreshSaves()
        saveStore.set({ activeId: meta.id })
        flashToast(`Overwrote "${meta.name}"`)
      }),
    load: (meta: SaveMeta) => withBusy(() => loadMeta(meta)),
    remove: (meta: SaveMeta) =>
      withBusy(async () => {
        if (!bridge) return
        await bridge.deleteSave(meta.id)
        await refreshSaves()
        if (saveStore.get().activeId === meta.id) saveStore.set({ activeId: null })
      }),
    newGame: () =>
      withBusy(async () => {
        await startSession({ kind: 'new' })
        saveStore.set({ open: false, activeId: null })
        flashToast('New game')
      }),
  }
  saveStore.setController(controller)

  // Autosave on a cadence, and best-effort on quit. Rotates through a small ring of `auto` slots
  // (the main process prunes older ones). Skipped while the menu is open (nothing is advancing).
  const AUTOSAVE_MS = 3 * 60 * 1000
  const autosave = async (): Promise<void> => {
    if (!bridge || !session) return
    await bridge.saveGame({ kind: 'auto', snapshot: session.serialize() })
    await refreshSaves()
  }
  setInterval(() => {
    if (!saveStore.get().open) void autosave()
  }, AUTOSAVE_MS)
  globalThis.addEventListener('beforeunload', () => {
    // Fire-and-forget: the page is going away, so we can't await the IPC round-trip.
    if (bridge && session) void bridge.saveGame({ kind: 'auto', snapshot: session.serialize() })
  })

  // Global hotkeys: F5 quicksave, F9 quickload, Esc toggles the menu. Ignored while typing in a
  // field (e.g. the save-name input) so the keys reach the input instead.
  globalThis.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement | null
    const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA'
    if (e.key === 'F5') {
      e.preventDefault()
      void controller.quickSave()
    } else if (e.key === 'F9') {
      e.preventDefault()
      void controller.quickLoad()
    } else if (e.key === 'Escape' && !typing) {
      e.preventDefault()
      if (saveStore.get().open) controller.close()
      else controller.open()
    }
  })

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
  let lastAlpha = 0
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

    const sess = session
    if (!sess) {
      requestAnimationFrame(frame)
      return
    }

    // The menu pauses the sim: we stop advancing but keep drawing a frozen frame so the paused
    // world stays on screen (and resetting `last` above avoids a huge delta jump on resume).
    if (saveStore.get().open) {
      renderer.render(sess.world, lastAlpha)
    } else {
      // Belts step a whole tile per move-cycle; interpolate across the cycle (not the tick)
      // so items glide one tile at a time instead of teleporting on the move tick.
      const subTickAlpha = sess.scheduler.advance(sess.world, deltaMs)
      lastAlpha = beltMoveAlpha(sess.state, subTickAlpha)
      renderer.render(sess.world, lastAlpha)
    }

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
      for (let i = 0; i < sess.state.research.completed.length; i++) {
        const id = techIdByInt.get(sess.state.research.completed[i]!)
        if (id !== undefined && !sess.researchedIds.has(id)) {
          sess.researchedIds.add(id)
          grew = true
        }
      }
      if (grew) void refreshBuildBar()
      if (sess.state.research.activeTech === RESEARCH_NONE) {
        const next = techs.find(
          (t) => !sess.researchedIds.has(t.id) && t.prereqs.every((p) => sess.researchedIds.has(p)),
        )
        if (next) enqueueSetActiveResearch(sess.world, { tech: next.int, cost: next.cost })
      }
      // Refresh the inspector so a pinned/hovered object's live numbers stay current.
      sess.inspect.refresh()
      statsStore.set({
        tick: sess.world.tick,
        entities: entityCount(sess.world),
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
