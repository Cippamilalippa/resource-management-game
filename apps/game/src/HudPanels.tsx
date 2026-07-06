import { useState } from 'react'
import { useSyncExternalStore } from 'react'
import { hudStore, type HudTech, type HudProductionRow, type HudVillage } from './hudStore.ts'
import { productionHistory } from './productionHistory.ts'
import { Icon, type IconName } from './Icon.tsx'
import { ResourceLabel } from './ResourceLabel.tsx'

/** A packed 0xRRGGBB colour as a CSS hex string. */
function cssColor(color: number): string {
  return `#${(color >>> 0).toString(16).padStart(6, '0')}`
}

/**
 * A tiny inline trend line for a resource's make rate over the recent samples. Pure presentation:
 * it reads the rolling {@link productionHistory} (wall-clock sampled, never the sim). A flat/empty
 * series renders as a baseline.
 */
function Sparkline({ color }: { color: number }): React.JSX.Element {
  const version = useSyncExternalStore(
    productionHistory.subscribe,
    productionHistory.getVersion,
    productionHistory.getVersion,
  )
  // `version` re-subscribes the component each push; the series read is keyed off it.
  void version
  const samples = productionHistory.series(color)
  const w = 56
  const h = 16
  const n = samples.length
  const max = Math.max(1, ...samples)
  const points =
    n < 2
      ? `0,${h} ${w},${h}`
      : samples
          .map(
            (v, i) =>
              `${((i / (n - 1)) * w).toFixed(1)},${(h - (v / max) * (h - 2) - 1).toFixed(1)}`,
          )
          .join(' ')
  return (
    <svg className="hud-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <polyline points={points} fill="none" stroke={cssColor(color)} strokeWidth="1.5" />
    </svg>
  )
}

/** Format a per-second rate: two decimals below 10, rounded above (matches the inspector). */
function rate(perSec: number): string {
  if (perSec <= 0) return '0/s'
  return `${perSec >= 10 ? Math.round(perSec) : Number(perSec.toFixed(2))}/s`
}

/** A thin labelled progress bar (0..1 fill), optionally tinted by a resource colour. */
function Bar({ frac, tone }: { frac: number; tone?: 'good' | 'warn' | 'bad' }): React.JSX.Element {
  return (
    <span className="hud-bar">
      <span
        className={`hud-bar-fill${tone ? ` ${tone}` : ''}`}
        style={{ width: `${Math.max(0, Math.min(1, frac)) * 100}%` }}
      />
    </span>
  )
}

/** Research screen: active tech + per-pack progress, then the tech tree grouped by status. */
function ResearchPanel(): React.JSX.Element {
  const research = useSyncExternalStore(
    hudStore.subscribe,
    () => hudStore.get().research,
    () => hudStore.get().research,
  )
  const select = (id: string): void => hudStore.getController()?.selectResearch(id)

  const available = research.techs.filter((t) => t.available)
  const locked = research.techs.filter((t) => !t.researched && !t.available && !t.active)
  const done = research.techs.filter((t) => t.researched)

  return (
    <div className="hud-panel">
      <h2 className="hud-title">
        <Icon name="FlaskConical" size={16} /> Research
        <span className="hud-sub">{research.labCount} labs</span>
      </h2>

      <div className="hud-section">
        {research.activeId ? (
          <>
            <div className="hud-active">Researching {research.activeName}</div>
            {research.progress.map((p, i) => (
              <div key={i} className="hud-progress-row">
                <ResourceLabel color={p.color} size={14} showName={false} />
                <Bar frac={p.amount > 0 ? p.progress / p.amount : 1} tone="good" />
                <span className="hud-progress-num">
                  {p.progress}/{p.amount}
                </span>
              </div>
            ))}
          </>
        ) : (
          <div className="hud-idle">No active research — pick a technology below.</div>
        )}
      </div>

      {available.length > 0 && (
        <div className="hud-section">
          <div className="hud-section-head">Available</div>
          {available.map((t) => (
            <TechRow key={t.id} tech={t} onSelect={() => select(t.id)} />
          ))}
        </div>
      )}
      {locked.length > 0 && (
        <div className="hud-section">
          <div className="hud-section-head">Locked</div>
          {locked.map((t) => (
            <TechRow key={t.id} tech={t} />
          ))}
        </div>
      )}
      {done.length > 0 && (
        <div className="hud-section">
          <div className="hud-section-head">Researched ({done.length})</div>
          <div className="hud-done-list">
            {done.map((t) => (
              <span key={t.id} className="hud-done-chip">
                <Icon name="Check" size={12} /> {t.name}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/** One selectable/locked technology row with its per-pack cost. */
function TechRow({ tech, onSelect }: { tech: HudTech; onSelect?: () => void }): React.JSX.Element {
  const body = (
    <>
      <span className="hud-tech-name">{tech.name}</span>
      <span className="hud-tech-cost">
        {tech.cost.map((c, i) => (
          <span key={i} className="hud-tech-costitem">
            <ResourceLabel color={c.color} size={13} showName={false} />
            {c.amount}
          </span>
        ))}
      </span>
    </>
  )
  if (onSelect) {
    return (
      <button
        className="hud-tech hud-tech-avail"
        onClick={onSelect}
        title={`Research ${tech.name}`}
      >
        {body}
      </button>
    )
  }
  return (
    <div className="hud-tech hud-tech-locked" title={`Requires: ${tech.prereqs.join(', ')}`}>
      <Icon name="Lock" size={12} />
      {body}
    </div>
  )
}

/** Village panel: each village's stage, demands vs. buffer, and growth/decline progress. */
function VillagePanel(): React.JSX.Element {
  const villages = useSyncExternalStore(
    hudStore.subscribe,
    () => hudStore.get().villages,
    () => hudStore.get().villages,
  )

  return (
    <div className="hud-panel">
      <h2 className="hud-title">
        <Icon name="House" size={16} /> Villages
        <span className="hud-sub">{villages.length}</span>
      </h2>
      {villages.length === 0 && <div className="hud-idle">No villages.</div>}
      {villages.map((v) => (
        <VillageCard key={`${v.x},${v.y}`} v={v} />
      ))}
    </div>
  )
}

function VillageCard({ v }: { v: HudVillage }): React.JSX.Element {
  // Show whichever trend is active: decline takes visual priority over growth.
  const declining = v.declineTimer > 0
  const frac = declining ? v.declineTimer / v.declineNeeded : v.growthTimer / v.growthNeeded
  return (
    <div className="hud-section">
      <div className="hud-section-head">
        {v.name}
        <span className="hud-sub">
          Lvl {v.level}
          {v.level <= v.maxStage + 1 && ` of ${v.maxStage + 1}`}
        </span>
        <span className="hud-sub">pop {v.population}</span>
      </div>
      {v.demands.map((d, i) => (
        <div key={i} className="hud-progress-row">
          <ResourceLabel color={d.color} size={14} showName={false} />
          <Bar frac={d.ratePerMin > 0 ? d.have / d.ratePerMin : 1} tone={d.met ? 'good' : 'bad'} />
          <span className="hud-progress-num">
            {d.have}
            <span className="hud-sub">/{d.ratePerMin}/min</span>
          </span>
        </div>
      ))}
      <div className="hud-trend">
        <span className={declining ? 'bad' : 'good'}>
          {declining ? 'Declining' : v.level > v.maxStage + 1 ? 'Max level' : 'Growing'}
        </span>
        <Bar frac={frac} tone={declining ? 'bad' : 'good'} />
      </div>
    </div>
  )
}

/** Production panel: installed throughput per resource (produced vs. consumed). */
function ProductionPanel(): React.JSX.Element {
  const production = useSyncExternalStore(
    hudStore.subscribe,
    () => hudStore.get().production,
    () => hudStore.get().production,
  )

  return (
    <div className="hud-panel">
      <h2 className="hud-title">
        <Icon name="ChartColumn" size={16} /> Production
        <span className="hud-sub">installed rate</span>
      </h2>
      {production.length === 0 && <div className="hud-idle">No crafters built yet.</div>}
      {production.length > 0 && (
        <div className="hud-prod-grid">
          <span className="hud-prod-h" />
          <span className="hud-prod-h">make</span>
          <span className="hud-prod-h">use</span>
          <span className="hud-prod-h">trend</span>
          {production.map((p: HudProductionRow) => (
            <ProductionRow key={p.color} p={p} />
          ))}
        </div>
      )}
    </div>
  )
}

function ProductionRow({ p }: { p: HudProductionRow }): React.JSX.Element {
  return (
    <>
      <ResourceLabel color={p.color} size={14} />
      <span className={`hud-prod-num${p.producedPerSec > 0 ? ' good' : ''}`}>
        {rate(p.producedPerSec)}
      </span>
      <span
        className={`hud-prod-num${p.consumedPerSec > p.producedPerSec ? ' bad' : ''}`}
        title={
          p.consumedPerSec > p.producedPerSec ? 'Consumes faster than it is produced' : undefined
        }
      >
        {rate(p.consumedPerSec)}
      </span>
      <Sparkline color={p.color} />
    </>
  )
}

type Tab = 'research' | 'villages' | 'production'

const TABS: readonly { readonly key: Tab; readonly icon: IconName; readonly label: string }[] = [
  { key: 'research', icon: 'FlaskConical', label: 'Research' },
  { key: 'villages', icon: 'House', label: 'Villages' },
  { key: 'production', icon: 'ChartColumn', label: 'Production' },
]

/**
 * Right-side rail of HUD toggles plus the one open panel. One panel is open at a time; clicking an
 * active tab closes it. All panels read the HUD store (populated by the boot loop each refresh) and
 * never touch the sim, except research selection which goes through the wired {@link HudController}.
 */
export function HudPanels(): React.JSX.Element {
  const [open, setOpen] = useState<Tab | null>(null)

  return (
    <div className="hud-rail-wrap">
      <div className="hud-rail">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`hud-rail-btn${open === t.key ? ' active' : ''}`}
            onClick={() => setOpen((cur) => (cur === t.key ? null : t.key))}
            title={t.label}
            aria-label={t.label}
            aria-pressed={open === t.key}
          >
            <Icon name={t.icon} size={20} />
          </button>
        ))}
      </div>
      {open === 'research' && <ResearchPanel />}
      {open === 'villages' && <VillagePanel />}
      {open === 'production' && <ProductionPanel />}
    </div>
  )
}
