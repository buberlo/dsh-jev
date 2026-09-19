/**
 * `@buberlo/dsh-jev` — the DeepSeek Harness plugin that binds the
 * harness-independent `@buberlo/jev-core` decision layer to verified DSH
 * extension points.
 *
 * Default configuration is `mock + shadow`: deterministic local answers, no
 * network traffic, no behavior change. Set `provider: live` with an explicit
 * `apiKey` to transmit state to TypeSafe, and `mode: enforce` to apply
 * decisions.
 *
 * @module @buberlo/dsh-jev
 */

export const name = 'dsh-jev'

export { Config, resolveSettings, buildSelectionCatalog } from './config.js'
export type { Config as JevPluginConfig, ResolvedSettings, ModelRouteConfig } from './config.js'
export { JevRuntime, type JevStats } from './service.js'
export { AgentState, type Snapshot } from './state.js'

export { default } from './service.js'
