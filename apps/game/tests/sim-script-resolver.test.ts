import { describe, it, expect } from 'vitest'
import { matchScriptKey } from '../src/sim.ts'

/**
 * The renderer bundles mod scripts via Vite's `import.meta.glob` and maps a mod's
 * manifest script path back to the matching bundled key. The mapping is the one bit of
 * pure logic in the otherwise test-exempt renderer glue, so it gets direct coverage.
 */
describe('matchScriptKey', () => {
  const keys = [
    '../../../mods/base/scripts/main.ts',
    '../../../mods/base/scripts/sub/extra.ts',
    '../../../mods/other/scripts/main.ts',
  ]

  it('matches a mod directory + manifest-relative script path to its glob key', () => {
    expect(matchScriptKey(keys, 'base', 'scripts/main.ts')).toBe(
      '../../../mods/base/scripts/main.ts',
    )
    expect(matchScriptKey(keys, 'other', 'scripts/main.ts')).toBe(
      '../../../mods/other/scripts/main.ts',
    )
  })

  it('matches nested script paths', () => {
    expect(matchScriptKey(keys, 'base', 'scripts/sub/extra.ts')).toBe(
      '../../../mods/base/scripts/sub/extra.ts',
    )
  })

  it('returns undefined when no script is bundled for the mod', () => {
    expect(matchScriptKey(keys, 'base', 'scripts/missing.ts')).toBeUndefined()
    expect(matchScriptKey(keys, 'ghost', 'scripts/main.ts')).toBeUndefined()
  })

  it('anchors the directory so "base" never matches a "database" mod', () => {
    const dbKeys = ['../../../mods/database/scripts/main.ts']
    expect(matchScriptKey(dbKeys, 'base', 'scripts/main.ts')).toBeUndefined()
    expect(matchScriptKey(dbKeys, 'database', 'scripts/main.ts')).toBe(
      '../../../mods/database/scripts/main.ts',
    )
  })
})
