/**
 * Data shapes for the balance model. These are a READ-ONLY superset of the base-mod prototype
 * JSON (`mods/base/prototypes/*.json`): the same `{ item, amount }` flows and `time`/`category`
 * fields the game validates, minus the render-only bits (icons, colors, sizes) the model ignores.
 *
 * Keeping the schema aligned with the real prototypes is deliberate — this tool is meant to
 * double as the authoring pipeline, so numbers you balance here are the numbers you ship.
 */

/** A `{ item, amount }` ingredient or result entry, exactly as authored in recipes. */
export interface Flow {
  readonly item: string
  readonly amount: number
}

/** A production recipe. An empty `ingredients` list means terrain extraction (a raw source). */
export interface Recipe {
  readonly id: string
  readonly category: string
  readonly ingredients: readonly Flow[]
  readonly results: readonly Flow[]
  /** Craft duration in sim ticks at crafter speed 1. */
  readonly time: number
  readonly requiresTerrain?: string
}

/** A produced/consumed good. Only identity + display name matter to the model. */
export interface Item {
  readonly id: string
  readonly name: string
}

/** A crafting building. `speed` scales how fast it runs a recipe of a matching category. */
export interface Crafter {
  readonly id: string
  readonly name: string
  readonly categories: readonly string[]
  readonly speed: number
}

/** The parsed, normalized prototype set the model operates on. */
export interface Dataset {
  readonly items: ReadonlyMap<string, Item>
  readonly recipes: readonly Recipe[]
  readonly crafters: readonly Crafter[]
  /** category id -> fastest crafter speed that provides it (drives machine-count ratios). */
  readonly categorySpeed: ReadonlyMap<string, number>
  /**
   * category id -> the distinct crafter speeds available for it, ascending — the machine-tier
   * ladder (mk1, mk2, …). One entry means the category has a single machine tier. Drives the
   * per-tier footprint report ("mk1 works but needs N machines; mk3 needs N/4").
   */
  readonly categoryTiers: ReadonlyMap<string, readonly number[]>
}
