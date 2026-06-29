import { useSyncExternalStore } from 'react'
import { statsStore } from './statsStore.ts'
import { BuildBar } from './BuildBar.tsx'
import { InfoSidebar } from './InfoSidebar.tsx'

/** DOM overlay panel: live tick + entity counts read from the sim each frame. */
export function App(): React.JSX.Element {
  const stats = useSyncExternalStore(statsStore.subscribe, statsStore.get, statsStore.get)

  return (
    <>
      <div className="panel">
        <h1>Factory — Debug</h1>
        <div className="row">
          <span>Tick</span>
          <span className="value">{stats.tick.toLocaleString()}</span>
        </div>
        <div className="row">
          <span>Entities</span>
          <span className="value">{stats.entities.toLocaleString()}</span>
        </div>
        <div className="row">
          <span>Prototypes</span>
          <span className="value">{stats.prototypes.toLocaleString()}</span>
        </div>
        <div className="row">
          <span>FPS</span>
          <span className="value">{stats.fps}</span>
        </div>
        <div className="row">
          <span>Mods</span>
          <span className="value">{stats.mods}</span>
        </div>
      </div>
      <div className="hint">
        WASD to pan · scroll to zoom · hover to inspect · click to select · pick a tool to build
      </div>
      <BuildBar />
      <InfoSidebar />
    </>
  )
}
