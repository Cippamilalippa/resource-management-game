import { icons, type LucideProps } from 'lucide-react'

/** Any valid lucide icon name in PascalCase, e.g. `'Road'`, `'Wheat'`, `'Factory'`. */
export type IconName = keyof typeof icons

interface IconProps extends LucideProps {
  /** Which lucide glyph to draw. */
  readonly name: IconName
  /**
   * Small badge drawn in the top-right corner of the icon box. Used for the belt Mk
   * tier as a Roman numeral (`I`, `II`, `III`, …); omitted when there is no tier.
   */
  readonly badge?: string | undefined
}

/**
 * The single icon primitive for the game UI. Wraps a lucide glyph so every icon flows
 * through one place: consistent sizing, the optional corner badge, and a single seam for
 * future theming. **Always render icons through this component** rather than importing
 * lucide glyphs directly, so the badge/box conventions stay uniform.
 */
export function Icon({ name, badge, ...props }: IconProps): React.JSX.Element {
  const Glyph = icons[name]
  return (
    <span className="icon">
      <Glyph aria-hidden {...props} />
      {badge ? <span className="icon-badge">{badge}</span> : null}
    </span>
  )
}

/** Greatest-to-least Roman numeral pieces, including the subtractive forms. */
const ROMAN: readonly (readonly [number, string])[] = [
  [1000, 'M'],
  [900, 'CM'],
  [500, 'D'],
  [400, 'CD'],
  [100, 'C'],
  [90, 'XC'],
  [50, 'L'],
  [40, 'XL'],
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
]

/** Convert a positive integer to a Roman numeral (used for Mk-tier badges); `''` if invalid. */
export function toRoman(n: number): string {
  if (!Number.isInteger(n) || n <= 0) return ''
  let out = ''
  for (const [value, sym] of ROMAN) {
    while (n >= value) {
      out += sym
      n -= value
    }
  }
  return out
}
