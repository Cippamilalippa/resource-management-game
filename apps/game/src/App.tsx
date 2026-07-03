import { useSyncExternalStore } from 'react'
import { appStore } from './appStore.ts'
import { BuildBar } from './BuildBar.tsx'
import { InfoSidebar } from './InfoSidebar.tsx'
import { SaveMenu } from './SaveMenu.tsx'
import { HudPanels } from './HudPanels.tsx'
import { Alerts } from './Alerts.tsx'
import { Objectives } from './Objectives.tsx'
import { MainMenu } from './MainMenu.tsx'
import { NewGameSetup } from './NewGameSetup.tsx'
import { TopBar } from './TopBar.tsx'
import { HelpOverlay } from './HelpOverlay.tsx'
import { DebugOverlay } from './DebugOverlay.tsx'
import { BlueprintLibrary } from './BlueprintLibrary.tsx'

/**
 * Root of the DOM overlay. Renders the in-game HUD only while a session is on screen (`playing`);
 * the menu shells and the save menu stay mounted so they work from the boot menu too.
 */
export function App(): React.JSX.Element {
  const app = useSyncExternalStore(appStore.subscribe, appStore.get, appStore.get)
  const playing = app.phase === 'playing'

  return (
    <>
      {playing && (
        <>
          <TopBar />
          <Alerts />
          <HudPanels />
          <Objectives />
          <BuildBar />
          <BlueprintLibrary />
          <InfoSidebar />
          <HelpOverlay />
          <DebugOverlay />
        </>
      )}
      <MainMenu />
      <NewGameSetup />
      <SaveMenu />
    </>
  )
}
