import { readFile, access, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { FileSource } from './fileSource.ts'

/**
 * Node-backed {@link FileSource} rooted at a directory on disk. Used by the
 * headless runner, tests and the Electron main process. (The renderer never
 * imports this — it has no fs access — so browser bundles stay clean.)
 */
export class NodeFileSource implements FileSource {
  readonly #root: string

  constructor(root: string) {
    this.#root = resolve(root)
  }

  get root(): string {
    return this.#root
  }

  async readText(path: string): Promise<string> {
    return readFile(join(this.#root, path), 'utf8')
  }

  async exists(path: string): Promise<boolean> {
    try {
      await access(join(this.#root, path))
      return true
    } catch {
      return false
    }
  }
}

/**
 * Discover every mod under a directory: each immediate subfolder that contains a
 * `manifest.json` becomes a {@link NodeFileSource}. The base game in `mods/base`
 * is found by this exact scan — there is no privileged path for first-party
 * content. Folders are returned in a stable (alphabetical) order so discovery is
 * deterministic regardless of the OS's directory-listing order; the loader's
 * dependency sort then runs on top of that.
 */
export async function discoverModSources(modsDir: string): Promise<NodeFileSource[]> {
  const root = resolve(modsDir)
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const names = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
  const sources: NodeFileSource[] = []
  for (const name of names) {
    const source = new NodeFileSource(join(root, name))
    if (await source.exists('manifest.json')) sources.push(source)
  }
  return sources
}
