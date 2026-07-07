import { useSyncExternalStore } from 'react'
import { hudStore } from './hudStore.ts'
import { Icon } from './Icon.tsx'

/** Compact numeric formatting for the credit readout: 12 · 3.4k · 1.2M. */
function fmt(n: number): string {
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(1))}M`
  if (n >= 1_000) return `${Number((n / 1_000).toFixed(1))}k`
  return String(n)
}

/** Signed compact form for the Δ/min readout: +12/min · -3.4k/min. */
function fmtDelta(n: number): string {
  return `${n > 0 ? '+' : '-'}${fmt(Math.abs(n))}/min`
}

/**
 * Always-visible credit strip (top bar): the single treasury balance every build cost is paid
 * from and every depot sale feeds, plus its recent per-minute drift — so the player can read
 * affordability and cash-flow direction at a glance (the ghost already tints red when a placement
 * is out of reach). Reads the HUD store only; never touches the sim.
 */
export function TreasuryBar(): React.JSX.Element | null {
  const hud = useSyncExternalStore(
    hudStore.subscribe,
    () => hudStore.get(),
    () => hudStore.get(),
  )
  const delta = Math.round(hud.creditsPerMin)
  return (
    <div className="treasury glass" role="status" aria-label="Credits">
      <Icon name="Landmark" size={15} />
      <span className="treasury-item" title={`${hud.credits} credits`}>
        <span className="treasury-amt">{fmt(hud.credits)}¢</span>
      </span>
      {delta !== 0 && (
        <span
          className="treasury-item treasury-delta"
          title="Credits per minute (recent)"
          style={{ color: delta > 0 ? '#7dd87d' : '#e08080' }}
        >
          {fmtDelta(delta)}
        </span>
      )}
    </div>
  )
}
