import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { hashState } from '@factory/engine/persistence'
import { PrototypeRegistry } from '@factory/engine/data'
import { readManifest, loadMods } from '@factory/engine/modloader'
import { discoverModSources } from '@factory/engine/modloader/node'
import { createSim, type ClientPrototype } from '../src/sim.ts'
import type { DiscoveredModInfo } from '../electron/preload.ts'

/** Absolute path to the repo's /mods directory (apps/game/tests -> repo root -> mods). */
function modsDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../mods')
}

/**
 * Load the real base mod off disk the way the Electron main process does, returning
 * exactly what the renderer receives over IPC: the merged prototypes plus the per-mod
 * manifest + source-directory info the renderer needs to run each mod's scripts.
 */
async function loadBaseContent(): Promise<{
  prototypes: ClientPrototype[]
  discovered: DiscoveredModInfo[]
}> {
  const registry = new PrototypeRegistry()
  const sources = await discoverModSources(modsDir())
  const mods = await Promise.all(sources.map(readManifest))
  await loadMods(mods, registry)
  const discovered = mods.map((m, i) => ({
    dir: sources[i]!.root.split('/').pop()!,
    manifest: m.manifest,
  }))
  return { prototypes: registry.list() as ClientPrototype[], discovered }
}

describe('createSim (Electron/renderer mod-script wiring)', () => {
  it('executes the base mod script through the bundled ScriptResolver', async () => {
    const { prototypes, discovered } = await loadBaseContent()
    expect(discovered.map((d) => d.manifest.id)).toContain('base')

    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await createSim(prototypes, discovered)
      // The base mod's init logs through the ModApi's namespaced logger when it runs.
      expect(log.mock.calls.some((args) => String(args[0]).startsWith('[mod:base]'))).toBe(true)
    } finally {
      log.mockRestore()
    }
  })

  it('assembles a deterministic sim (same seed + ticks -> identical hash)', async () => {
    const { prototypes, discovered } = await loadBaseContent()
    const a = await createSim(prototypes, discovered, { kind: 'new' }, 7)
    const b = await createSim(prototypes, discovered, { kind: 'new' }, 7)
    a.scheduler.runTicks(a.world, 500)
    b.scheduler.runTicks(b.world, 500)
    expect(hashState(a.world)).toBe(hashState(b.world))
  })

  it('throws if a manifest references a script that was not bundled', async () => {
    const { prototypes } = await loadBaseContent()
    const bogus: DiscoveredModInfo[] = [
      {
        dir: 'base',
        manifest: {
          id: 'base',
          version: '0.0.0',
          dependencies: {},
          prototypes: [],
          scripts: ['scripts/does-not-exist.ts'],
        },
      },
    ]
    await expect(createSim(prototypes, bogus)).rejects.toThrow(/No bundled script/)
  })
})
