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
 */
export function ResourceLabel({
  color,
  showName = true,
  size = 16,
}: {
  readonly color: number
  /** Draw the resource's name next to the icon (default true); false renders just the icon. */
  readonly showName?: boolean
  /** Icon pixel size. */
  readonly size?: number
}): React.JSX.Element {
  const res = resourceByColor(color)
  if (!res) return <span className="swatch" style={{ background: cssColor(color) }} />
  return (
    <span className="resource-label">
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
