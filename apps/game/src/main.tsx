import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Renderer } from '@factory/engine/render'
import {
  DEFAULT_TICK_RATE,
  entityCount,
  type GameWorld,
  type Scheduler,
} from '@factory/engine/core'
import { SNAPSHOT_VERSION, type WorldSnapshot } from '@factory/engine/persistence'
import { App } from './App.tsx'
import { statsStore } from './statsStore.ts'
import { buildStore, type BuildItem } from './buildStore.ts'
import { blueprintStore } from './blueprintStore.ts'
import { installPlacement } from './placement.ts'
import { createSim, type ClientPrototype, type SimOrigin } from './sim.ts'
import { saveStore, type SaveController } from './saveStore.ts'
import { appStore, type AppController } from './appStore.ts'
import { simControlStore } from './simControlStore.ts'
import { hudStore, type HudController, type HudResearch, type HudTech } from './hudStore.ts'
import { buildMachineIndex, type MachineIndex } from './machines.ts'
import type { InspectRegistry } from './inspect.ts'
import type { GameState } from './gameLogic.ts'
import type { DiscoveredModInfo, SaveMeta } from '../electron/preload.ts'
import {
  beltMoveAlpha,
  buildableSet,
  techTypeOf,
  enqueueSetActiveResearch,
  villageStatuses,
  researchProgress,
  collectAlerts,
  productionFlows,
  scenarioList,
  gameObjectives,
  type ObjectiveId,
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
 * One 'producer'-kind build tool per crafter *building* (Factorio-style: one machine, its recipe
 * chosen after placement — not one tool per recipe). The tool carries the building's footprint,
 * colour and icon; `produceEvery` is only a placeholder cadence for the empty machine (a real
 * recipe overrides it via `set_recipe`). The recipe catalogue lives in {@link MachineIndex}.
 */
function machineItems(
  machines: MachineIndex,
  costOf: (protoId: string) => { color: number; amount: number }[],
): BuildItem[] {
  const items: BuildItem[] = []
  for (const def of machines.defs) {
    const cost = costOf(def.id)
    items.push({
      id: def.id,
      name: def.name,
      kind: 'producer',
      ...(def.icon ? { icon: def.icon } : {}),
      w: def.w,
      h: def.h,
      color: def.color,
      itemColor: def.color,
      accepts: [],
      ...(cost.length > 0 ? { cost } : {}),
      spawnEvery: 20,
      moveEvery: 1,
      produceEvery: def.recipes[0]?.craftEvery ?? 30,
      storage: def.storage,
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
  /** Human display name, derived from the id (no `name` is authored on the prototype). */
  readonly name: string
  readonly int: number
  /** Per-pack research cost as the sim consumes it: { pack colour, amount }. */
  readonly cost: readonly { color: number; amount: number }[]
  readonly prereqs: readonly string[]
}

/** Prettify a technology id (`tech.jet_propulsion`) into a title-cased label ("Jet Propulsion"). */
function techLabel(id: string): string {
  return id
    .replace(/^tech\./, '')
    .split('_')
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ')
}

/** Read every technology's { int id, display name, per-pack cost, prerequisites } from the prototypes. */
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
    metas.push({ id: p.id, name: techLabel(p.id), int: techTypeOf(p.id), cost, prereqs })
  }
  return metas
}

/** Map the placeable prototypes (buildings, belts, ports) and crafter machines to build-bar tools. */
function toBuildItems(prototypes: readonly ClientPrototype[], machines: MachineIndex): BuildItem[] {
  // Resource identity is the item's colour; build an id->colour lookup so a building's
  // `accepts` (a list of item ids) resolves to the colours the sim works in.
  const itemColors = new Map<string, number>()
  for (const p of prototypes) if (p.type === 'item') itemColors.set(p.id, num(p, 'color', 0xffffff))
  const colorOfItem = (id: unknown): number =>
    typeof id === 'string' ? (itemColors.get(id) ?? 0xffffff) : 0xffffff

  // A prototype's build cost, resolved from item ids to the resource colours the sim charges.
  const protoById = new Map<string, ClientPrototype>()
  for (const p of prototypes) protoById.set(p.id, p)
  const costOfProto = (p: ClientPrototype | undefined): { color: number; amount: number }[] => {
    const raw = Array.isArray(p?.buildCost) ? (p.buildCost as RecipeFlow[]) : []
    const out: { color: number; amount: number }[] = []
    for (const c of raw) {
      if (c && typeof c.item === 'string' && typeof c.amount === 'number') {
        out.push({ color: colorOfItem(c.item), amount: c.amount })
      }
    }
    return out
  }

  const items: BuildItem[] = []
  for (const p of prototypes) {
    const tool = toolKind(p.type)
    if (!tool) continue
    const size = (p.size ?? {}) as { w?: number; h?: number }
    const accepts = Array.isArray(p.accepts) ? p.accepts.map(colorOfItem) : []
    const cost = costOfProto(p)
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
      ...(p.depot === true ? { depot: true } : {}),
      ...(cost.length > 0 ? { cost } : {}),
      spawnEvery: num(p, 'spawnEvery', 20),
      moveEvery: num(p, 'moveEvery', 1),
      produceEvery: num(p, 'produceEvery', 30),
      storage: num(p, 'storage', 100),
      ...(typeof p.requiresTerrain === 'string' ? { requiresTerrain: p.requiresTerrain } : {}),
    })
  }
  // One 'producer' tool per crafter building (its recipe is chosen after placement); its cost is
  // authored on the crafter prototype, resolved here by the same item→colour map.
  items.push(...machineItems(machines, (id) => costOfProto(protoById.get(id))))
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

/** The starting scenario used for a one-click in-game restart (the menu flow picks one explicitly). */
const DEFAULT_SCENARIO = 'scenario.abundant'

/** A random uint32 seed. Host UI only — it merely *seeds* the deterministic sim RNG. */
function randomSeed(): number {
  return Math.floor(Math.random() * 0xffffffff) >>> 0
}

/** Display labels for the guided first-objectives checklist (the sim tracks only opaque ids). */
const OBJECTIVE_LABELS: Record<ObjectiveId, string> = {
  place_crafter: 'Place a machine (mine or crafter)',
  place_belt: 'Lay a conveyor belt',
  place_lab: 'Build a research lab',
  select_research: 'Choose a technology to research',
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
  // The machine catalogue (crafter buildings + the recipes each can run). Drives the build bar
  // (one tool per machine) and the sidebar recipe picker (via placement.ts).
  const machines = buildMachineIndex(prototypes)
  const allBuildItems = toBuildItems(prototypes, machines)

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
  // Suppress edge-of-screen camera panning unless a session is actively on screen and no save
  // overlay is open, so the view doesn't drift under a modal or on the menu shell.
  const syncEdgeScroll = (): void => {
    renderer.edgeScroll = appStore.get().phase === 'playing' && !saveStore.get().open
  }
  appStore.subscribe(syncEdgeScroll)
  saveStore.subscribe(syncEdgeScroll)
  syncEdgeScroll()

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
    // Keep every tool on the bar; mark the tech-gated, not-yet-researched ones locked (greyed and
    // unselectable) so the tech tree's payoff is visible before it's earned (M4 build affordances).
    const items = allBuildItems.map((i) => (buildable.has(i.id) ? i : { ...i, locked: true }))
    buildStore.setItems(items)
    // Stamp the build-bar glyph onto placed buildings/producers (keyed by their tile colour), and
    // the resource glyph onto every item riding a belt (keyed by its identity colour). Buildings go
    // last so a building colour wins over an item colour in the unlikely event the two collide.
    renderer.setIcons(new Map([...resourceTextures, ...(await buildIconTextures(items))]))
  }

  /** Build a fresh sim from an origin (new game or restored save) and make it the live session. */
  const startSession = async (origin: SimOrigin): Promise<void> => {
    const sim = await createSim(prototypes, discovered, origin)
    const inspect = installPlacement(renderer, sim.world, sim.state, sim.registry, machines)
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
    // A live session is on screen now — leave the menu/setup shells for the running game.
    appStore.set({ phase: 'playing' })
  }

  // Boot into the main menu rather than straight into a game: the player picks New Game / Continue
  // / Load. The scenario list drives the new-game setup screen; `hasSaves` gates Continue/Load.
  appStore.set({ scenarios: scenarioList(prototypes), unavailable: !window.factory })

  // ── HUD (research / village / alerts / production) ───────────────────────────────────────────
  // Assemble the research view-model: the sim tracks only integer tech ids, so enrich each with its
  // display name and status (researched / active / available) against the session's researched set.
  const techNameById = new Map(techs.map((t) => [t.id, t.name] as const))
  const buildResearchHud = (sess: Session): HudResearch => {
    const prog = researchProgress(sess.state)
    const activeMeta = prog.idle ? undefined : techs.find((t) => t.int === prog.activeTech)
    const techsVm: HudTech[] = techs.map((t) => {
      const researched = sess.researchedIds.has(t.id)
      const active = !prog.idle && t.int === prog.activeTech
      const available = !researched && !active && t.prereqs.every((p) => sess.researchedIds.has(p))
      return {
        id: t.id,
        name: t.name,
        researched,
        active,
        available,
        cost: t.cost.map((c) => ({ color: c.color, amount: c.amount })),
        prereqs: t.prereqs.map((p) => techNameById.get(p) ?? p),
      }
    })
    return {
      activeId: activeMeta?.id ?? null,
      activeName: activeMeta?.name ?? null,
      labCount: prog.labCount,
      progress: prog.cost.map((c) => ({ color: c.color, amount: c.amount, progress: c.progress })),
      techs: techsVm,
    }
  }

  // The research screen drives tech selection through here (only the boot loop can touch the world).
  const hudController: HudController = {
    selectResearch: (id) => {
      if (!session) return
      const meta = techs.find((t) => t.id === id)
      if (!meta) return
      if (session.researchedIds.has(id)) return // already researched
      if (session.state.research.activeTech === meta.int) return // already active — don't reset progress
      if (!meta.prereqs.every((p) => session!.researchedIds.has(p))) return // prerequisites unmet
      enqueueSetActiveResearch(session.world, { tech: meta.int, cost: meta.cost })
    },
  }
  hudStore.setController(hudController)

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
    const saves = await bridge.listSaves()
    saveStore.set({ saves })
    // The main menu enables Continue/Load only when at least one slot exists on disk.
    appStore.set({ hasSaves: saves.length > 0 })
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
        // A one-click in-game restart: fresh random seed + the default scenario (the menu's New
        // Game flow lets the player pick both explicitly).
        await startSession({ kind: 'new', seed: randomSeed(), scenario: DEFAULT_SCENARIO })
        saveStore.set({ open: false, activeId: null })
        flashToast('New game')
      }),
  }
  saveStore.setController(controller)

  // Best-effort autosave of the live session into a rotating `auto` slot (the main process prunes
  // older ones). Shared by the cadence timer, the quit/back-to-menu paths, and page unload.
  const autosave = async (): Promise<void> => {
    if (!bridge || !session) return
    await bridge.saveGame({ kind: 'auto', snapshot: session.serialize() })
    await refreshSaves()
  }

  // ── Main-menu / new-game controller ──────────────────────────────────────────────────────────
  // Drives the top-level shells (menu → setup → play). Starting a session flips the phase to
  // 'playing' inside startSession; returning to the menu just changes the phase (the session, if
  // any, stays built but paused behind the menu — the frame loop stops advancing it below).
  const appController: AppController = {
    showSetup: () => appStore.set({ phase: 'setup' }),
    backToMenu: () =>
      withBusy(async () => {
        // Best-effort autosave so Continue resumes exactly where you left, then drop to the menu.
        await autosave()
        saveStore.set({ open: false })
        appStore.set({ phase: 'menu' })
      }),
    startNew: (seed, scenario) =>
      withBusy(async () => {
        await startSession({ kind: 'new', seed, scenario })
        saveStore.set({ activeId: null })
      }),
    continueGame: () =>
      withBusy(async () => {
        if (!bridge) return
        const saves = await bridge.listSaves()
        // `listSaves` returns newest-first; Continue restores the most recent slot.
        const latest = saves[0]
        if (!latest) {
          saveStore.set({ error: 'No saves to continue.' })
          return
        }
        await loadMeta(latest)
      }),
    openLoad: () => {
      saveStore.set({ open: true, error: null })
      void withBusy(refreshSaves)
    },
    quit: () =>
      withBusy(async () => {
        // Best-effort autosave before tearing down, rather than relying on `beforeunload` firing
        // during Electron shutdown.
        await autosave()
        if (bridge) void bridge.quit()
      }),
  }
  appStore.setController(appController)
  // Populate the menu's save availability up-front (Continue/Load stay disabled until a slot exists).
  void withBusy(refreshSaves)

  // Autosave on a cadence. Skipped while the save menu is open or we're not in play (nothing is
  // advancing then, so the last cadence save already captured the state).
  const AUTOSAVE_MS = 3 * 60 * 1000
  setInterval(() => {
    if (!saveStore.get().open && appStore.get().phase === 'playing') void autosave()
  }, AUTOSAVE_MS)
  globalThis.addEventListener('beforeunload', () => {
    // Fire-and-forget: the page is going away, so we can't await the IPC round-trip.
    if (bridge && session) void bridge.saveGame({ kind: 'auto', snapshot: session.serialize() })
  })

  // Global hotkeys: F5 quicksave, F9 quickload, F10 toggles the save overlay. Esc is reserved for
  // deselecting a build tool (owned by BuildBar) — here it only *closes* the overlay if it is open,
  // never opens it, so it stays free to deselect. Ignored while typing in a field (e.g. the
  // save-name input) so the keys reach the input instead.
  globalThis.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement | null
    const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA'
    if ((e.key === 'c' || e.key === 'C') && (e.ctrlKey || e.metaKey) && !typing) {
      // Ctrl/Cmd+C arms copy-select (drag a rectangle to capture, then click to paste). Only while
      // a session is on screen; ignored while typing so it doesn't hijack text copy.
      if (appStore.get().phase !== 'playing') return
      e.preventDefault()
      blueprintStore.armCopy()
    } else if (e.key === 'F5') {
      e.preventDefault()
      void controller.quickSave()
    } else if (e.key === 'F9') {
      e.preventDefault()
      void controller.quickLoad()
    } else if (e.key === 'F10') {
      e.preventDefault()
      // Toggle the in-game save overlay while a session is on screen; the menu/setup shells own
      // their own dismissal, so it is inert there.
      if (appStore.get().phase !== 'playing') return
      if (saveStore.get().open) controller.close()
      else controller.open()
    } else if (e.key === 'Escape' && !typing) {
      // Close the overlay if it's open; otherwise leave Esc to BuildBar (deselect the build tool).
      if (appStore.get().phase === 'playing' && saveStore.get().open) {
        e.preventDefault()
        controller.close()
      }
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

    // The sim pauses while the save menu is open, the player paused playback, OR we're back in the
    // main menu / setup shell (phase !== 'playing'); we stop advancing but keep drawing a frozen
    // frame so the paused world stays on screen (and resetting `last` above avoids a huge delta jump
    // on resume). Otherwise the speed multiplier scales real frame time before it reaches the
    // fixed-timestep scheduler — the sim stays deterministic, it just runs more or fewer fixed ticks
    // per real second.
    if (
      saveStore.get().open ||
      simControlStore.get().paused ||
      appStore.get().phase !== 'playing'
    ) {
      renderer.render(sess.world, lastAlpha)
    } else {
      // Belts step a whole tile per move-cycle; interpolate across the cycle (not the tick)
      // so items glide one tile at a time instead of teleporting on the move tick.
      const subTickAlpha = sess.scheduler.advance(sess.world, deltaMs * simControlStore.get().speed)
      lastAlpha = beltMoveAlpha(sess.state, subTickAlpha)
      renderer.render(sess.world, lastAlpha)
    }

    // Throttle React updates to ~4 Hz so the overlay never gates the frame rate.
    if (now - lastStatsAt > 250) {
      fps = Math.round((frames * 1000) / (now - lastStatsAt))
      frames = 0
      lastStatsAt = now
      // Pull runtime tech completions into the researched set (the sim records completed techs as
      // integer ids; map them back to strings). Research is now player-driven through the M4
      // research screen — the host no longer auto-selects the next tech.
      let grew = false
      for (let i = 0; i < sess.state.research.completed.length; i++) {
        const id = techIdByInt.get(sess.state.research.completed[i]!)
        if (id !== undefined && !sess.researchedIds.has(id)) {
          sess.researchedIds.add(id)
          grew = true
        }
      }
      if (grew) void refreshBuildBar()
      // Push a fresh HUD snapshot for the M4 panels (research / villages / alerts / production).
      hudStore.set({
        research: buildResearchHud(sess),
        villages: villageStatuses(sess.state),
        alerts: collectAlerts(sess.state),
        production: productionFlows(sess.state).map((f) => ({
          color: f.color,
          producedPerSec: f.produced * DEFAULT_TICK_RATE,
          consumedPerSec: f.consumed * DEFAULT_TICK_RATE,
        })),
        // Guided onboarding checklist: the sim reports which steps the world satisfies; the host
        // attaches each step's display label. The panel hides itself once every step is done.
        objectives: gameObjectives(sess.state).map((o) => ({
          id: o.id,
          label: OBJECTIVE_LABELS[o.id],
          done: o.done,
        })),
      })
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
