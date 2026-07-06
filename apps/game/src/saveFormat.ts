/**
 * Pure display-formatting helpers for the save/load menu. Split out from `SaveMenu.tsx` so they're
 * testable without React/DOM — the menu itself just calls these to render a slot's meta.
 */

/** Format accumulated play-time seconds as `h:mm` (e.g. 3661 -> "1:01"); `0:00` for falsy input. */
export function formatPlayTime(seconds: number | undefined): string {
  const total = Math.max(0, Math.floor(seconds ?? 0))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  return `${h}:${String(m).padStart(2, '0')}`
}
