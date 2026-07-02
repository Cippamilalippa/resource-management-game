/**
 * UI-side store for the crafter recipe picker shown in the inspector sidebar. When the player pins
 * a crafter (clicks it), `placement.ts` publishes the machine's recipe options and its current
 * recipe here; the {@link RecipePanel} reads this via useSyncExternalStore and calls back through
 * the {@link RecipeController} (wired by `placement.ts`, which owns the world) to enqueue a
 * `set_recipe` command. Cleared whenever the pin is released or a non-crafter is selected.
 */
import type { RecipeChoice } from './machines.ts'

export interface RecipeSelection {
  readonly x: number
  readonly y: number
  readonly machineName: string
  /** Extraction machines (mines/derricks) auto-pick by terrain — the picker is read-only for them. */
  readonly extraction: boolean
  /** The building's current recipe integer id (0 = empty). */
  readonly currentInt: number
  /** Recipes offered for this machine (already terrain-filtered for extraction machines). */
  readonly options: readonly RecipeChoice[]
}

export interface RecipeController {
  /** Assign a recipe to the pinned crafter (enqueues set_recipe). */
  choose(recipe: RecipeChoice): void
}

let selection: RecipeSelection | null = null
let controller: RecipeController | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

export const recipeStore = {
  get: (): RecipeSelection | null => selection,
  set: (next: RecipeSelection | null): void => {
    selection = next
    emit()
  },
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  setController: (c: RecipeController): void => {
    controller = c
  },
  getController: (): RecipeController | null => controller,
}
