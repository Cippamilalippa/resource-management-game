import { describe, it, expect } from 'vitest'
import { formatPlayTime } from '../src/saveFormat.ts'
import { withSaveExtras } from '../electron/saveTypes.ts'
import type { SaveMeta, SaveRequest } from '../electron/saveTypes.ts'

/**
 * Q3 pure-logic coverage: play-time display formatting and the additive thumbnail/play-time merge
 * that keeps old saves (written before these fields existed) loading and listing unchanged.
 */
describe('formatPlayTime', () => {
  it('formats seconds as h:mm', () => {
    expect(formatPlayTime(0)).toBe('0:00')
    expect(formatPlayTime(59)).toBe('0:00')
    expect(formatPlayTime(60)).toBe('0:01')
    expect(formatPlayTime(3661)).toBe('1:01')
    expect(formatPlayTime(36000)).toBe('10:00')
  })

  it('falls back to 0:00 for missing/negative input', () => {
    expect(formatPlayTime(undefined)).toBe('0:00')
    expect(formatPlayTime(-5)).toBe('0:00')
  })
})

describe('withSaveExtras', () => {
  const core: Omit<SaveMeta, 'thumbnail' | 'playTimeSec'> = {
    id: 'slot-1',
    name: 'Save',
    kind: 'manual',
    tick: 100,
    seed: 1,
    snapshotVersion: 1,
    createdAt: 1000,
    updatedAt: 2000,
  }

  it('old saves stay loadable: no thumbnail/playTimeSec on either side yields none in the result', () => {
    const req: SaveRequest = { kind: 'manual', snapshot: {} }
    const meta = withSaveExtras(core, req)
    expect(meta).toEqual(core)
    expect('thumbnail' in meta).toBe(false)
    expect('playTimeSec' in meta).toBe(false)
  })

  it('prefers the incoming request thumbnail/playTimeSec over the prior slot', () => {
    const req: SaveRequest = {
      kind: 'manual',
      snapshot: {},
      thumbnail: 'data:new',
      playTimeSec: 120,
    }
    const meta = withSaveExtras(core, req, { thumbnail: 'data:old', playTimeSec: 60 })
    expect(meta.thumbnail).toBe('data:new')
    expect(meta.playTimeSec).toBe(120)
  })

  it('falls back to the prior slot when the request omits an extra (e.g. a failed capture)', () => {
    const req: SaveRequest = { kind: 'manual', snapshot: {} }
    const meta = withSaveExtras(core, req, { thumbnail: 'data:old', playTimeSec: 60 })
    expect(meta.thumbnail).toBe('data:old')
    expect(meta.playTimeSec).toBe(60)
  })

  it('treats playTimeSec 0 as a real value, not a missing one', () => {
    const req: SaveRequest = { kind: 'manual', snapshot: {}, playTimeSec: 0 }
    const meta = withSaveExtras(core, req, { playTimeSec: 999 })
    expect(meta.playTimeSec).toBe(0)
  })
})
