import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverModSources } from '../modloader/index.ts'

/**
 * discoverModSources scans a /mods directory: every subfolder with a manifest.json
 * becomes a source, in a stable (alphabetical) order. This is the exact path the
 * base game (mods/base) is loaded through — so these tests guard the dogfooding.
 */
describe('discoverModSources', () => {
  let root: string

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'mods-'))
    // Two real mods, intentionally created out of alphabetical order.
    for (const id of ['zeta', 'base']) {
      const dir = join(root, id)
      await mkdir(dir, { recursive: true })
      await writeFile(
        join(dir, 'manifest.json'),
        JSON.stringify({ id, version: '1.0.0', dependencies: {}, prototypes: [], scripts: [] }),
      )
    }
    // A folder without a manifest must be ignored.
    await mkdir(join(root, 'not-a-mod'), { recursive: true })
    await writeFile(join(root, 'not-a-mod', 'readme.txt'), 'ignore me')
    // A stray file at the root must be ignored.
    await writeFile(join(root, 'loose.txt'), 'ignore me too')
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('finds only subfolders that contain a manifest.json', async () => {
    const sources = await discoverModSources(root)
    expect(sources).toHaveLength(2)
  })

  it('returns sources in a stable alphabetical order (deterministic)', async () => {
    const sources = await discoverModSources(root)
    const ids = await Promise.all(
      sources.map(async (s) => {
        const manifest: unknown = JSON.parse(await s.readText('manifest.json'))
        return (manifest as { id: string }).id
      }),
    )
    expect(ids).toEqual(['base', 'zeta'])
  })

  it('returns an empty list for a missing directory rather than throwing', async () => {
    await expect(discoverModSources(join(root, 'does-not-exist'))).resolves.toEqual([])
  })
})
