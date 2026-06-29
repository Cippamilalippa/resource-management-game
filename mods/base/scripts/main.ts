/**
 * Base game ("mod zero") entry script.
 *
 * For this scaffolding pass the script execution sandbox is OUT OF SCOPE, so this
 * file is not run yet — it exists to prove the manifest -> scripts path is wired
 * and to show the shape future base-game logic will take. When the sandbox lands,
 * the loader will call a default export like the one below, handing it the SAME
 * stable mod API a third-party mod receives.
 */
import type { ModApi } from '@factory/engine/scripting'

export default function init(api: ModApi): void {
  api.log('base game init (stub) — no gameplay systems registered yet')
}
