import { useSyncExternalStore } from 'react'
import { hudStore } from './hudStore.ts'

/**
 * The guided first-objectives checklist: an ordered list of onboarding steps that tick off live as
 * the player satisfies them (the sim recomputes each from world state — see `gameObjectives`). The
 * whole panel hides once every step is done, or before any objective exists. Read-only.
 */
export function Objectives(): React.JSX.Element | null {
  const hud = useSyncExternalStore(hudStore.subscribe, hudStore.get, hudStore.get)
  const objectives = hud.objectives
  if (objectives.length === 0 || objectives.every((o) => o.done)) return null

  const doneCount = objectives.filter((o) => o.done).length
  return (
    <div className="objectives">
      <div className="objectives-head">
        Getting Started
        <span className="objectives-count">
          {doneCount}/{objectives.length}
        </span>
      </div>
      <ul className="objectives-list">
        {objectives.map((o) => (
          <li key={o.id} className={`objective${o.done ? ' done' : ''}`}>
            <span className="objective-check">{o.done ? '✓' : '○'}</span>
            <span className="objective-label">{o.label}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
