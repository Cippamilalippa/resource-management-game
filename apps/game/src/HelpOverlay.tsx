import { useEffect, useState } from 'react'
import { Icon } from './Icon.tsx'

/** Shortcut groups shown in the help panel — a readable replacement for the old run-on hint line. */
const GROUPS: readonly { readonly title: string; readonly keys: readonly [string, string][] }[] = [
  {
    title: 'Camera',
    keys: [
      ['WASD', 'Pan'],
      ['Scroll', 'Zoom'],
    ],
  },
  {
    title: 'Build',
    keys: [
      ['1–9 / 0', 'Pick tool'],
      ['R', 'Rotate port'],
      ['Esc', 'Deselect / back'],
      ['Hover / Click', 'Inspect / pin'],
    ],
  },
  {
    title: 'Simulation',
    keys: [
      ['Space', 'Pause'],
      ['[  /  ]', 'Speed down / up'],
    ],
  },
  {
    title: 'Saves & tools',
    keys: [
      ['F10', 'Save menu'],
      ['F5 / F9', 'Quicksave / quickload'],
      ['F3', 'Debug stats'],
      ['?', 'This help'],
    ],
  },
]

/**
 * The controls help: a compact "?" button pinned bottom-right, plus a shortcut reference panel it
 * toggles (also on the `?` key). Replaces the former long single-line hint. Purely presentational —
 * it reads nothing from the sim. Keypresses are ignored while typing in a field.
 */
export function HelpOverlay(): React.JSX.Element {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      if (e.key === '?') {
        e.preventDefault()
        setOpen((v) => !v)
      } else if (e.key === 'Escape' && open) {
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <>
      {open && (
        <div className="help-panel glass" role="dialog" aria-label="Keyboard shortcuts">
          <div className="help-head">
            Controls
            <button
              className="sidebar-close"
              onClick={() => setOpen(false)}
              aria-label="Close help"
            >
              ×
            </button>
          </div>
          <div className="help-groups">
            {GROUPS.map((g) => (
              <div key={g.title} className="help-group">
                <div className="help-group-title">{g.title}</div>
                {g.keys.map(([key, desc]) => (
                  <div key={key} className="help-row">
                    <kbd className="help-key">{key}</kbd>
                    <span className="help-desc">{desc}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
      <button
        className="help-btn glass"
        onClick={() => setOpen((v) => !v)}
        title="Controls (?)"
        aria-label="Controls"
        aria-pressed={open}
      >
        <Icon name="Keyboard" size={16} />
        <span>Controls</span>
      </button>
    </>
  )
}
