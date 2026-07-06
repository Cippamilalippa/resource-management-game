import { useEffect, useSyncExternalStore } from 'react'
import { detailOverlayStore } from './detailOverlayStore.ts'
import { Icon } from './Icon.tsx'

/**
 * Floating toggle for the on-map detail overlay ("alt-mode", also on the `Alt` key — Factorio's
 * convention): stamps every machine with what it's configured to make (its product glyph, or a warn
 * marker when it has no recipe yet) and every filtered port with its colour chips, so the whole
 * factory is legible at a glance. Purely a view toggle — the renderer draws the marks from read-only
 * selectors and never mutates the sim. The choice is persisted (see {@link detailOverlayStore}).
 */
export function DetailOverlay(): React.JSX.Element {
  const { on } = useSyncExternalStore(
    detailOverlayStore.subscribe,
    detailOverlayStore.get,
    detailOverlayStore.get,
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      // A bare Alt press toggles alt-mode. Guard auto-repeat and modifier combos (Alt+Tab etc.),
      // and preventDefault so the OS/Electron menu bar doesn't steal focus off the Alt keystroke.
      if (e.key === 'Alt' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        e.preventDefault()
        detailOverlayStore.toggle()
      }
    }
    // Also swallow the matching keyup: on Windows/Linux Electron the menu bar activates on the Alt
    // *release*, so preventing the keydown alone can still flash it.
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.key === 'Alt') e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  return (
    <button
      className={`overlay-btn detail-btn glass${on ? ' active' : ''}`}
      onClick={() => detailOverlayStore.toggle()}
      title="Detail overlay — show what every machine makes (Alt)"
      aria-label="Detail overlay"
      aria-pressed={on}
    >
      <Icon name="ScanEye" size={16} />
      <span>Detail</span>
    </button>
  )
}
