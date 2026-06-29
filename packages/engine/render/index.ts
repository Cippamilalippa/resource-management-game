/**
 * engine/render — PixiJS renderer. Reads sim state and draws it; it is forbidden
 * from mutating the sim. Depends on core (for components/queries) only.
 */
export { Renderer, type RendererOptions, type Ghost, type Highlight } from './renderer.ts'
export { Camera } from './camera.ts'
