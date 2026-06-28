import { readFile, access } from 'node:fs/promises'
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
