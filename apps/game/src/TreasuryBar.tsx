import { useSyncExternalStore } from 'react'
import { hudStore } from './hudStore.ts'
import { ResourceLabel } from './ResourceLabel.tsx'
import { Icon } from './Icon.tsx'
import { encyclopediaStore } from './encyclopedia.ts'

/** Compact numeric formatting for the balance chips: 12 · 3.4k · 1.2M. */
function fmt(n: number): string {
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(1))}M`
  if (n >= 1_000) return `${Number((n / 1_000).toFixed(1))}k`
  return String(n)
}

/**
 * Always-visible treasury strip (top bar): the banked build-cost resources and how much of each is
 * held, so the player can read affordability at a glance — the ghost already tints red when a
 * placement is out of reach, this shows the actual balance. Reads the HUD store only; never touches
 * the sim.
 */
export function TreasuryBar(): React.JSX.Element | null {
  const treasury = useSyncExternalStore(
    hudStore.subscribe,
    () => hudStore.get().treasury,
    () => hudStore.get().treasury,
  )
  if (treasury.length === 0) return null

  return (
    <div className="treasury glass" role="status" aria-label="Treasury">
      <Icon name="Landmark" size={15} />
      {treasury.map((b) => (
        <span className="treasury-item" key={b.color} title={`${b.amount}`}>
          <ResourceLabel
            color={b.color}
            size={15}
            showName={false}
            onClick={() => encyclopediaStore.openForItem(b.color)}
          />
          <span className="treasury-amt">{fmt(b.amount)}</span>
        </span>
      ))}
    </div>
  )
}
