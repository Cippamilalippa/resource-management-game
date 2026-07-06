import { Icon } from './Icon.tsx'
import { resourceByColor } from './resources.ts'

/** 0xRRGGBB packed color -> CSS hex string. */
function cssColor(color: number): string {
  return `#${(color >>> 0).toString(16).padStart(6, '0')}`
}

/**
 * Show a resource by its identity colour: its icon (tinted the resource's colour) and, by default,
 * its name — so anywhere the game refers to a resource it reads the same way (icon + colour + name)
 * instead of an anonymous swatch. Resolved through the {@link resourceByColor} registry; a colour no
 * item claims falls back to a bare colour swatch, matching the old presentation.
 *
 * Passing `onClick` (Q4) makes the label a click-through into the recipe encyclopedia filtered on
 * this item — used by the treasury bar, the inspector's accepts/produces rows and recipe ingredient
 * rows. It's opt-in so plain display uses (e.g. inside an already-interactive recipe-choice button)
 * stay inert.
 */
export function ResourceLabel({
  color,
  showName = true,
  size = 16,
  onClick,
}: {
  readonly color: number
  /** Draw the resource's name next to the icon (default true); false renders just the icon. */
  readonly showName?: boolean
  /** Icon pixel size. */
  readonly size?: number
  /** When set, the label becomes clickable/focusable (e.g. open the encyclopedia on this item). */
  readonly onClick?: (e: React.MouseEvent) => void
}): React.JSX.Element {
  const res = resourceByColor(color)
  const clickProps = onClick
    ? {
        onClick,
        role: 'button' as const,
        tabIndex: 0,
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onClick(e as unknown as React.MouseEvent)
          }
        },
      }
    : {}
  const clickableClass = onClick ? ' clickable' : ''
  if (!res)
    return (
      <span
        className={`swatch${clickableClass}`}
        style={{ background: cssColor(color) }}
        {...clickProps}
      />
    )
  return (
    <span className={`resource-label${clickableClass}`} {...clickProps}>
      <Icon name={res.icon} size={size} color={cssColor(color)} />
      {showName && <span className="resource-name">{res.name}</span>}
      {/* Hovering the icon names the resource everywhere it appears; redundant when the name is
          already rendered inline, so only shown for the icon-only presentation. */}
      {!showName && (
        <span className="resource-popover" role="tooltip">
          {res.name}
        </span>
      )}
    </span>
  )
}
