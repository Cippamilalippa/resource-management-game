/**
 * Top-level application phase store: which shell the overlay shows — the main menu, the new-game
 * setup screen, or the running game. The boot loop (main.tsx) owns the world and implements the
 * {@link AppController}; the React shells read this state via useSyncExternalStore and drive the
 * controller. Kept separate from {@link import('./saveStore.ts')} (which models the in-game
 * save/load overlay) so the menu flow and the save flow don't entangle.
 */
import type { ScenarioInfo } from './gameLogic.ts'

/** Which top-level shell is on screen. */
export type AppPhase = 'menu' | 'setup' | 'playing'

export interface AppUiState {
  readonly phase: AppPhase
  /** Selectable starting scenarios for the new-game screen (from the loaded prototypes). */
  readonly scenarios: readonly ScenarioInfo[]
  /** Whether any save exists on disk — gates the menu's Continue/Load actions. */
  readonly hasSaves: boolean
  /** True in a plain browser (no Electron bridge): saving/quitting are unavailable. */
  readonly unavailable: boolean
}

/**
 * The imperative surface the menu/setup shells drive. Implemented by the boot loop (only it can
 * build/swap the live session). All disk-touching actions are async and report through the save
 * store's busy/error channel, so the shells never talk to the Electron bridge directly.
 */
export interface AppController {
  /** Menu → new-game setup screen. */
  showSetup(): void
  /** Setup/in-game → main menu (the running session, if any, is left paused behind it). */
  backToMenu(): void
  /** Start a fresh game with the chosen seed + scenario, then enter play. */
  startNew(seed: number, scenario: string): Promise<void>
  /** Load the most recent save and enter play (no-op if none exists). */
  continueGame(): Promise<void>
  /** Open the save/load overlay to pick a slot to load. */
  openLoad(): void
  /** Quit the application (desktop only). */
  quit(): void
}

const initial: AppUiState = {
  phase: 'menu',
  scenarios: [],
  hasSaves: false,
  unavailable: false,
}

let state: AppUiState = initial
let controller: AppController | null = null
const listeners = new Set<() => void>()

export const appStore = {
  get: (): AppUiState => state,
  set: (patch: Partial<AppUiState>): void => {
    state = { ...state, ...patch }
    for (const l of listeners) l()
  },
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  setController: (c: AppController): void => {
    controller = c
  },
  getController: (): AppController | null => controller,
}
