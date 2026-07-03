import { useEffect, useState } from 'react'
import { blueprintStore } from './blueprintStore.ts'
import { Icon } from './Icon.tsx'

/**
 * The blueprint library overlay: the persistent catalogue of saved blueprints (localStorage-backed),
 * plus the naming prompt shown right after a "save-to-library" capture. Selecting a blueprint arms
 * the paste ghost (handled in `placement.ts`); "New blueprint" arms copy-select in save mode so the
 * next drag becomes a named blueprint. Purely presentational — it drives the sim only indirectly,
 * through `blueprintStore` intents that `placement.ts` turns into placement commands.
 */
export function BlueprintLibrary(): React.JSX.Element | null {
  const clip = blueprintStore.get()
  // Re-render on store changes (library, naming flow, open state) via a tiny version bump.
  const [, force] = useState(0)
  useEffect(() => blueprintStore.subscribe(() => force((v) => v + 1)), [])

  const [name, setName] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')

  // The naming prompt takes over whenever a save-to-library capture is awaiting a name.
  const naming = clip.naming

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (naming) blueprintStore.cancelNaming()
      else if (clip.libraryOpen) blueprintStore.closeLibrary()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [naming, clip.libraryOpen])

  if (naming) {
    return (
      <div className="bp-modal glass" role="dialog" aria-label="Name blueprint">
        <div className="bp-head">Name blueprint</div>
        <form
          className="bp-name-form"
          onSubmit={(e) => {
            e.preventDefault()
            blueprintStore.saveNamed(name)
            setName('')
          }}
        >
          <input
            className="bp-input"
            autoFocus
            value={name}
            placeholder={`${naming.w}×${naming.h} · ${naming.entries.length} objects`}
            onChange={(e) => setName(e.target.value)}
            aria-label="Blueprint name"
          />
          <div className="bp-actions">
            <button type="submit" className="bp-btn primary">
              Save
            </button>
            <button
              type="button"
              className="bp-btn"
              onClick={() => {
                blueprintStore.cancelNaming()
                setName('')
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    )
  }

  if (!clip.libraryOpen) return null

  return (
    <div className="bp-modal glass" role="dialog" aria-label="Blueprint library">
      <div className="bp-head">
        Blueprints
        <button
          className="sidebar-close"
          onClick={() => blueprintStore.closeLibrary()}
          aria-label="Close blueprints"
        >
          ×
        </button>
      </div>
      <button
        className="bp-new"
        onClick={() => {
          blueprintStore.closeLibrary()
          blueprintStore.armCopy(true)
        }}
        title="Drag a rectangle over the factory to capture a new blueprint"
      >
        <Icon name="Plus" size={16} />
        <span>New blueprint (drag to capture)</span>
      </button>
      {clip.saved.length === 0 ? (
        <div className="bp-empty">No blueprints yet. Create one to reuse a layout.</div>
      ) : (
        <ul className="bp-list">
          {clip.saved.map((s) => (
            <li key={s.id} className="bp-item">
              {renaming === s.id ? (
                <form
                  className="bp-rename-form"
                  onSubmit={(e) => {
                    e.preventDefault()
                    blueprintStore.renameSaved(s.id, renameText)
                    setRenaming(null)
                  }}
                >
                  <input
                    className="bp-input"
                    autoFocus
                    value={renameText}
                    onChange={(e) => setRenameText(e.target.value)}
                    onBlur={() => setRenaming(null)}
                    aria-label="Rename blueprint"
                  />
                </form>
              ) : (
                <button
                  className="bp-item-main"
                  onClick={() => blueprintStore.selectSaved(s.id)}
                  title="Select to paste"
                >
                  <Icon name="ClipboardList" size={16} />
                  <span className="bp-item-name">{s.name}</span>
                  <span className="bp-item-meta">
                    {s.blueprint.w}×{s.blueprint.h} · {s.blueprint.entries.length}
                  </span>
                </button>
              )}
              <button
                className="bp-icon-btn"
                onClick={() => {
                  setRenaming(s.id)
                  setRenameText(s.name)
                }}
                title="Rename"
                aria-label="Rename blueprint"
              >
                <Icon name="Pencil" size={14} />
              </button>
              <button
                className="bp-icon-btn"
                onClick={() => blueprintStore.deleteSaved(s.id)}
                title="Delete"
                aria-label="Delete blueprint"
              >
                <Icon name="Trash2" size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
