import { useEffect } from 'react'
import { useSyncExternalStore } from 'react'
import { simControlStore, SIM_SPEEDS } from './simControlStore.ts'
import { Icon } from './Icon.tsx'

/**
 * Playback controls: pause/resume and a speed selector. Reads the sim-control store (the boot
 * loop polls the same store each frame to decide whether/how fast to advance the scheduler). Space
 * toggles pause; `[` / `]` step the speed down/up — bound to the window so they work without focus,
 * and ignored while typing in a field. Never touches the sim directly.
 */
export function SimControls(): React.JSX.Element {
  const { paused, speed } = useSyncExternalStore(
    simControlStore.subscribe,
    simControlStore.get,
    simControlStore.get,
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      if (e.code === 'Space') {
        e.preventDefault()
        simControlStore.togglePause()
      } else if (e.key === ']') {
        const i = SIM_SPEEDS.indexOf(speed as (typeof SIM_SPEEDS)[number])
        simControlStore.setSpeed(SIM_SPEEDS[Math.min(SIM_SPEEDS.length - 1, i + 1)]!)
      } else if (e.key === '[') {
        const i = SIM_SPEEDS.indexOf(speed as (typeof SIM_SPEEDS)[number])
        simControlStore.setSpeed(SIM_SPEEDS[Math.max(0, i - 1)]!)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [speed])

  return (
    <div className="simctl">
      <button
        className={`simctl-btn${paused ? ' active' : ''}`}
        onClick={() => simControlStore.togglePause()}
        title={paused ? 'Resume (Space)' : 'Pause (Space)'}
        aria-label={paused ? 'Resume' : 'Pause'}
        aria-pressed={paused}
      >
        <Icon name={paused ? 'Play' : 'Pause'} size={16} />
      </button>
      <div className="simctl-speeds" role="group" aria-label="Simulation speed">
        {SIM_SPEEDS.map((s) => (
          <button
            key={s}
            className={`simctl-speed${!paused && speed === s ? ' active' : ''}`}
            onClick={() => simControlStore.setSpeed(s)}
            title={`${s}× speed`}
            aria-pressed={!paused && speed === s}
          >
            {s}×
          </button>
        ))}
      </div>
    </div>
  )
}
