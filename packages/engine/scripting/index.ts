/**
 * engine/scripting — the stable mod API surface. This pass defines the contract
 * only; the execution sandbox is intentionally out of scope.
 */
export { createModApi, type ModApi, type ModApiHost } from './modApi.ts'
