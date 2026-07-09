import { useEffect } from 'react'
import { useSyncExternalStore } from 'react'
import { useModal } from './modalStore.ts'
import {
  settingsStore,
  AUTOSAVE_OPTIONS,
  UI_SCALE_MIN,
  UI_SCALE_MAX,
  VOLUME_MIN,
  VOLUME_MAX,
  MUSIC_VOLUME_MIN,
  MUSIC_VOLUME_MAX,
} from './settingsStore.ts'
import { Icon } from './Icon.tsx'

/** A labelled row wrapping a single control, laid out label-left / control-right. */
function Row({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="settings-row">
      <div className="settings-row-label">
        <span>{label}</span>
        {hint && <span className="settings-row-hint">{hint}</span>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  )
}

/** A segmented pick-one control (used for the autosave cadence). */
function Segmented<T extends number>({
  options,
  value,
  format,
  onChange,
}: {
  options: readonly T[]
  value: T
  format: (v: T) => string
  onChange: (v: T) => void
}): React.JSX.Element {
  return (
    <div className="settings-seg" role="group">
      {options.map((opt) => (
        <button
          key={opt}
          className={`settings-seg-btn${opt === value ? ' active' : ''}`}
          onClick={() => onChange(opt)}
          aria-pressed={opt === value}
        >
          {format(opt)}
        </button>
      ))}
    </div>
  )
}

/** A two-state on/off toggle. */
function Toggle({
  on,
  onToggle,
  labelOn = 'On',
  labelOff = 'Off',
}: {
  on: boolean
  onToggle: () => void
  labelOn?: string
  labelOff?: string
}): React.JSX.Element {
  return (
    <button
      className={`settings-toggle${on ? ' on' : ''}`}
      onClick={onToggle}
      role="switch"
      aria-checked={on}
    >
      <span className="settings-toggle-track">
        <span className="settings-toggle-thumb" />
      </span>
      <span className="settings-toggle-text">{on ? labelOn : labelOff}</span>
    </button>
  )
}

/**
 * The settings overlay: a modal (styled like the save/recipe modals) exposing sound volume, UI
 * scale, autosave cadence, edge-scroll and pause-on-blur. Reads/writes only {@link settingsStore},
 * which persists to localStorage and pushes volume into the sfx layer — it never touches sim state.
 * The boot loop freezes the sim while it is open (mirroring the save menu). Esc closes.
 */
export function SettingsMenu(): React.JSX.Element | null {
  const s = useSyncExternalStore(settingsStore.subscribe, settingsStore.get, settingsStore.get)

  // `O` toggles; Esc-to-close is owned by the central modal stack (modalStore).
  useModal('settings', s.open, () => settingsStore.close())
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      if ((e.key === 'o' || e.key === 'O') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault()
        settingsStore.toggle()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!s.open) return null

  return (
    <div className="settings-backdrop" onClick={() => settingsStore.close()}>
      <div
        className="settings-modal"
        role="dialog"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-head">
          <Icon name="Settings" size={16} />
          <h2>Settings</h2>
          <button
            className="sidebar-close"
            onClick={() => settingsStore.close()}
            aria-label="Close settings"
          >
            ×
          </button>
        </div>

        <div className="settings-body">
          <Row label="Master volume" hint="M to mute">
            <input
              type="range"
              className="settings-range"
              min={VOLUME_MIN}
              max={VOLUME_MAX}
              step={5}
              value={s.masterVolume}
              onChange={(e) => settingsStore.update({ masterVolume: Number(e.target.value) })}
              aria-label="Master volume"
            />
            <span className="settings-value">{s.masterVolume}%</span>
          </Row>

          <Row label="Music volume" hint="Generative ambient score">
            <input
              type="range"
              className="settings-range"
              min={MUSIC_VOLUME_MIN}
              max={MUSIC_VOLUME_MAX}
              step={5}
              value={s.musicVolume}
              onChange={(e) => settingsStore.update({ musicVolume: Number(e.target.value) })}
              aria-label="Music volume"
            />
            <span className="settings-value">{s.musicVolume}%</span>
          </Row>

          <Row label="Factory ambience" hint="Machine-hum bed that follows how busy you are">
            <Toggle
              on={s.ambience}
              onToggle={() => settingsStore.update({ ambience: !s.ambience })}
            />
          </Row>

          <Row label="UI scale">
            <input
              type="range"
              className="settings-range"
              min={UI_SCALE_MIN}
              max={UI_SCALE_MAX}
              step={5}
              value={s.uiScale}
              onChange={(e) => settingsStore.update({ uiScale: Number(e.target.value) })}
              aria-label="UI scale"
            />
            <span className="settings-value">{s.uiScale}%</span>
          </Row>

          <Row label="Autosave">
            <Segmented
              options={AUTOSAVE_OPTIONS}
              value={s.autosaveMin}
              format={(v) => (v === 0 ? 'Off' : `${v}m`)}
              onChange={(autosaveMin) => settingsStore.update({ autosaveMin })}
            />
          </Row>

          <Row label="Edge scrolling" hint="Pan when the cursor hits a screen edge">
            <Toggle
              on={s.edgeScroll}
              onToggle={() => settingsStore.update({ edgeScroll: !s.edgeScroll })}
            />
          </Row>

          <Row label="Pause when unfocused" hint="Auto-pause when the window loses focus">
            <Toggle
              on={s.pauseOnBlur}
              onToggle={() => settingsStore.update({ pauseOnBlur: !s.pauseOnBlur })}
            />
          </Row>
        </div>
      </div>
    </div>
  )
}

/**
 * The in-game gear button (bottom-right, alongside Recipes/Controls) that opens {@link SettingsMenu}.
 * Rendered only during play; the main menu opens the same modal from its own entry.
 */
export function SettingsButton(): React.JSX.Element {
  const s = useSyncExternalStore(settingsStore.subscribe, settingsStore.get, settingsStore.get)
  return (
    <button
      className="settings-btn glass"
      onClick={() => settingsStore.toggle()}
      title="Settings"
      aria-label="Settings"
      aria-pressed={s.open}
    >
      <Icon name="Settings" size={16} />
      <span>Settings</span>
    </button>
  )
}
