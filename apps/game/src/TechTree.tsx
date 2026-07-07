import { useEffect, useMemo, useRef, useState } from 'react'
import type { HudResearch, HudTech, HudUnlock } from './hudStore.ts'
import { layoutTechTree, prereqChain, TECH_LAYOUT_METRICS } from './techLayout.ts'
import { Icon } from './Icon.tsx'
import { isIconName } from './buildIcons.ts'
import { ResourceLabel } from './ResourceLabel.tsx'

/** A packed 0xRRGGBB colour as a CSS hex string. */
function cssColor(color: number): string {
  return `#${(color >>> 0).toString(16).padStart(6, '0')}`
}

/** Show at most this many unlock badges on a node; the rest collapse into a "+N" chip. */
const MAX_UNLOCK_BADGES = 6

/** One unlock badge: a building shows its own glyph tinted its colour, a recipe its product. */
function UnlockBadge({ unlock }: { unlock: HudUnlock }): React.JSX.Element {
  if (unlock.kind === 'recipe') {
    return (
      <span className="tech-unlock">
        <ResourceLabel color={unlock.color} size={13} showName={false} />
      </span>
    )
  }
  const icon = unlock.icon && isIconName(unlock.icon) ? unlock.icon : 'Warehouse'
  return (
    <span className="tech-unlock" title={unlock.name}>
      <Icon name={icon} size={13} color={cssColor(unlock.color)} />
    </span>
  )
}

/** The unlock-preview strip: capped badge row; hovering it lists every grant by name. */
function UnlockStrip({ unlocks }: { unlocks: readonly HudUnlock[] }): React.JSX.Element | null {
  if (unlocks.length === 0) return null
  const overflow = unlocks.length > MAX_UNLOCK_BADGES
  const shown = overflow ? unlocks.slice(0, MAX_UNLOCK_BADGES - 1) : unlocks
  return (
    <span className="tech-node-unlocks" title={`Unlocks: ${unlocks.map((u) => u.name).join(', ')}`}>
      {shown.map((u) => (
        <UnlockBadge key={u.id} unlock={u} />
      ))}
      {overflow && <span className="tech-unlock-more">+{unlocks.length - shown.length}</span>}
    </span>
  )
}

/**
 * The research tree as a real graph (U3): a scrollable layered DAG of compact tech cards with SVG
 * prerequisite edges. Node state is colour-coded (researched / available / locked / active with a
 * progress fill); the active tech's whole prerequisite chain is highlighted. Clicking an available
 * node selects it through the wired HUD controller (the only sim-facing path); clicking a locked
 * node flashes its unmet prerequisites. Pure presentation — layout math lives in `techLayout.ts`.
 */
export function TechTreeGraph({
  research,
  onSelect,
}: {
  readonly research: HudResearch
  readonly onSelect: (id: string) => void
}): React.JSX.Element {
  const techs = research.techs
  const layout = useMemo(
    () => layoutTechTree(techs.map((t) => ({ id: t.id, prereqs: t.prereqIds }))),
    [techs],
  )
  const techById = useMemo(() => new Map(techs.map((t) => [t.id, t] as const)), [techs])

  // The active tech's transitive prerequisite chain — those edges/cards get the accent treatment.
  const chain = useMemo(
    () =>
      research.activeId
        ? prereqChain(
            research.activeId,
            techs.map((t) => ({ id: t.id, prereqs: t.prereqIds })),
          )
        : null,
    [research.activeId, techs],
  )

  // Clicking a locked tech flashes its unmet prerequisites; `nonce` keys the cards so a repeat
  // click on the same node restarts the CSS animation.
  const [flash, setFlash] = useState<{ ids: ReadonlySet<string>; nonce: number }>({
    ids: new Set(),
    nonce: 0,
  })
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(flashTimer.current), [])
  const flashUnmet = (tech: HudTech): void => {
    const unmet = tech.prereqIds.filter((p) => !(techById.get(p)?.researched ?? false))
    if (unmet.length === 0) return
    setFlash((f) => ({ ids: new Set(unmet), nonce: f.nonce + 1 }))
    clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(
      () => setFlash((f) => ({ ids: new Set(), nonce: f.nonce })),
      900,
    )
  }

  // Overall fill fraction for the active card (all packs pooled — a coarse "how far along" cue;
  // the per-pack readout above the tree stays the precise view).
  let need = 0
  let got = 0
  for (const p of research.progress) {
    need += p.amount
    got += Math.min(p.progress, p.amount)
  }
  const activeFrac = need > 0 ? got / need : 0

  const m = TECH_LAYOUT_METRICS
  return (
    <div className="tech-graph-wrap">
      <div className="tech-graph" style={{ width: layout.width, height: layout.height }}>
        <svg
          className="tech-edges"
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          aria-hidden="true"
        >
          {layout.edges.map((e) => {
            const from = layout.byId.get(e.from)
            const to = layout.byId.get(e.to)
            if (!from || !to) return null
            const x1 = from.x + m.nodeW
            const y1 = from.y + m.nodeH / 2
            const x2 = to.x
            const y2 = to.y + m.nodeH / 2
            const cx = m.gapX / 2
            const onChain = chain !== null && chain.has(e.to) && chain.has(e.from)
            const done = techById.get(e.from)?.researched ?? false
            return (
              <path
                key={`${e.from}->${e.to}`}
                className={`tech-edge${onChain ? ' chain' : done ? ' done' : ''}`}
                d={`M ${x1} ${y1} C ${x1 + cx} ${y1}, ${x2 - cx} ${y2}, ${x2} ${y2}`}
              />
            )
          })}
        </svg>
        {layout.nodes.map((n) => {
          const tech = techById.get(n.id)
          if (!tech) return null
          const state = tech.active
            ? 'active'
            : tech.researched
              ? 'researched'
              : tech.available
                ? 'available'
                : 'locked'
          const flashing = flash.ids.has(n.id)
          const onChain = chain !== null && chain.has(n.id)
          const title =
            state === 'locked'
              ? `${tech.name} — requires ${tech.prereqs.join(', ')}`
              : state === 'available'
                ? `Research ${tech.name}`
                : tech.name
          return (
            <button
              key={flashing ? `${n.id}#${flash.nonce}` : n.id}
              className={`tech-node ${state}${onChain ? ' chain' : ''}${flashing ? ' flash' : ''}`}
              style={{ left: n.x, top: n.y, width: m.nodeW, height: m.nodeH }}
              onClick={() => {
                if (state === 'available') onSelect(n.id)
                else if (state === 'locked') flashUnmet(tech)
              }}
              title={title}
              aria-label={title}
              aria-disabled={state !== 'available'}
            >
              {tech.active && (
                <span
                  className="tech-node-fill"
                  style={{ width: `${Math.min(1, activeFrac) * 100}%` }}
                />
              )}
              <span className="tech-node-name">
                {state === 'locked' && <Icon name="Lock" size={11} />}
                {state === 'researched' && <Icon name="Check" size={11} />}
                {state === 'active' && <Icon name="FlaskConical" size={11} />}
                {tech.name}
              </span>
              {tech.cost.length > 0 && (
                <span className="tech-node-cost">
                  {tech.cost.map((c, i) => (
                    <span key={i} className="hud-tech-costitem">
                      <ResourceLabel color={c.color} size={12} showName={false} />
                      {c.amount}
                    </span>
                  ))}
                </span>
              )}
              <UnlockStrip unlocks={tech.unlocks} />
            </button>
          )
        })}
      </div>
    </div>
  )
}
