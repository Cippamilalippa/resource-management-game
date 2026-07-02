/**
 * Load prototype JSON into a normalized {@link Dataset}. Reads every `*.json` in a directory and
 * buckets entries by their `type` field, exactly like the mod loader's directory scan — so it
 * eats the real `mods/base/prototypes` unchanged, or any experimental data dir with the same
 * shape. Validation is intentionally light (shape only); the game's `validateContent` remains the
 * authority. This just needs enough structure to compute costs, and throws loudly on malformed
 * flows so a typo can't silently skew a balance number.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Crafter, Dataset, Flow, Item, Recipe } from './types.ts'

interface RawProto {
  readonly id?: unknown
  readonly type?: unknown
  readonly [key: string]: unknown
}

function fail(msg: string): never {
  throw new Error(`[balance/load] ${msg}`)
}

function asFlows(protoId: string, field: string, raw: unknown): Flow[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) fail(`${protoId}: "${field}" must be an array`)
  return raw.map((entry, i): Flow => {
    const e = entry as Record<string, unknown>
    if (typeof e?.item !== 'string') fail(`${protoId}: ${field}[${i}].item must be a string`)
    if (typeof e.amount !== 'number' || !(e.amount > 0)) {
      fail(`${protoId}: ${field}[${i}].amount must be a positive number`)
    }
    return { item: e.item, amount: e.amount }
  })
}

function asStringList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []
}

/** Read + parse every JSON file in `dir` into a flat list of prototype records. */
function readProtos(dir: string): RawProto[] {
  const out: RawProto[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const text = readFileSync(join(dir, name), 'utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      fail(`${name}: invalid JSON — ${(err as Error).message}`)
    }
    if (!Array.isArray(parsed)) fail(`${name}: expected a top-level array of prototypes`)
    for (const p of parsed as RawProto[]) {
      if (typeof p?.id !== 'string' || typeof p.type !== 'string') {
        fail(`${name}: every prototype needs string "id" and "type"`)
      }
      out.push(p)
    }
  }
  return out
}

export function loadDataset(dir: string): Dataset {
  const protos = readProtos(dir)

  const items = new Map<string, Item>()
  const recipes: Recipe[] = []
  const crafters: Crafter[] = []

  for (const p of protos) {
    const id = p.id as string
    switch (p.type) {
      case 'item': {
        items.set(id, { id, name: typeof p.name === 'string' ? p.name : id })
        break
      }
      case 'recipe': {
        if (typeof p.time !== 'number' || !(p.time > 0)) fail(`${id}: recipe "time" must be > 0`)
        const recipe: Recipe = {
          id,
          category:
            typeof p.category === 'string' ? p.category : fail(`${id}: recipe needs "category"`),
          ingredients: asFlows(id, 'ingredients', p.ingredients),
          results: asFlows(id, 'results', p.results),
          time: p.time,
          ...(typeof p.requiresTerrain === 'string' ? { requiresTerrain: p.requiresTerrain } : {}),
        }
        if (recipe.results.length === 0) fail(`${id}: recipe needs at least one result`)
        recipes.push(recipe)
        break
      }
      case 'crafter': {
        crafters.push({
          id,
          name: typeof p.name === 'string' ? p.name : id,
          categories: asStringList(p.craftingCategories),
          speed: typeof p.speed === 'number' && p.speed > 0 ? p.speed : 1,
        })
        break
      }
      default:
        break // villages, belts, terrains, resources — irrelevant to the production-cost model
    }
  }

  // category -> fastest speed available (best-case machine ratio for that step).
  const categorySpeed = new Map<string, number>()
  // category -> every distinct speed available (the machine-tier ladder, ascending).
  const tierSet = new Map<string, Set<number>>()
  for (const c of crafters) {
    for (const cat of c.categories) {
      categorySpeed.set(cat, Math.max(categorySpeed.get(cat) ?? 0, c.speed))
      const set = tierSet.get(cat) ?? new Set<number>()
      set.add(c.speed)
      tierSet.set(cat, set)
    }
  }
  const categoryTiers = new Map<string, readonly number[]>(
    [...tierSet].map(([cat, speeds]) => [cat, [...speeds].sort((a, b) => a - b)]),
  )

  return { items, recipes, crafters, categorySpeed, categoryTiers }
}
