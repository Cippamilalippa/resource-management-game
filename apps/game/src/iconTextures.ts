import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { icons } from 'lucide-react'
import { Texture } from 'pixi.js'
import type { BuildItem } from './buildStore.ts'
import { iconForItem } from './buildIcons.ts'
import type { Resource } from './resources.ts'

/** Resolution the lucide glyph is rasterized at; downscaled to ~30% of a tile when drawn. */
const ICON_PX = 64

/** Kinds we stamp a map icon onto: the solid-tile structures (everything else carries its own
 *  directional glyph already). */
const ICONED_KINDS: ReadonlySet<BuildItem['kind']> = new Set(['building', 'producer'])

/** Render a lucide glyph (the very one the build bar shows) to an SVG data URL, white-stroked so
 *  it reads on top of the building's coloured tile. */
function glyphDataUrl(name: keyof typeof icons): string {
  const svg = renderToStaticMarkup(
    createElement(icons[name], { color: '#ffffff', size: ICON_PX, strokeWidth: 2 }),
  )
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/** Decode a data URL into a Pixi texture once the browser has rasterized it. */
async function loadTexture(dataUrl: string): Promise<Texture> {
  const img = new Image()
  img.src = dataUrl
  await img.decode()
  return Texture.from(img)
}

/**
 * Build the `color -> Texture` map the renderer draws as a top-right overlay on placed buildings.
 * Keyed by each prototype's colour — the same value the renderer paints the tile with, and unique
 * per prototype — so the renderer can resolve a building's icon from its entity colour alone. Only
 * buildings and producers are iconed; belts/ports/splitters keep their own directional glyphs.
 */
export async function buildIconTextures(
  items: readonly BuildItem[],
): Promise<Map<number, Texture>> {
  const textures = new Map<number, Texture>()
  await Promise.all(
    items
      .filter((item) => ICONED_KINDS.has(item.kind))
      .map(async (item) => {
        const tex = await loadTexture(glyphDataUrl(iconForItem(item).name))
        textures.set(item.color >>> 0, tex)
      }),
  )
  return textures
}

/**
 * Build the `color -> Texture` map for *resources* — the glyph drawn centred on each item as it
 * rides a belt, keyed by the item's identity colour (see {@link Resource}). Built once at boot
 * (resources don't change with research) and merged with the building overlays into the single
 * map the renderer resolves by entity colour. The renderer centres these on the item circle while
 * corner-badging the building ones; both are just white glyphs on the tile's own colour.
 */
export async function resourceIconTextures(
  resources: readonly Resource[],
): Promise<Map<number, Texture>> {
  const textures = new Map<number, Texture>()
  await Promise.all(
    resources.map(async (res) => {
      const tex = await loadTexture(glyphDataUrl(res.icon))
      textures.set(res.color >>> 0, tex)
    }),
  )
  return textures
}
