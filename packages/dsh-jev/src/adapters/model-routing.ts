/**
 * Model-routing adapter on the `agent/request` waterfall.
 *
 * The core chooses a configured route class; this adapter resolves it to a
 * real provider/model pair and only replaces the request configuration when
 * the target is verified against the live LLM provider catalog. DSH documents
 * catalog membership as advisory, so this check is deliberately conservative:
 * an unlisted or unreachable target falls back to the existing model.
 *
 * @module dsh-jev/adapters/model-routing
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ModelTarget } from '@buberlo/jev-core'
import type { LlmCallConfig, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { describeThrown, type JevRuntime } from '../service.js'

const CATALOG_TTL_MS = 30_000

/** Install the `agent/request` listener. */
export function installModelAdapter(ctx: Context, runtime: JevRuntime): void {
  let cache: { at: number; targets: ModelTarget[] } | undefined

  const listTargets = async (llm: LlmRuntime): Promise<ModelTarget[]> => {
    if (cache !== undefined && Date.now() - cache.at < CATALOG_TTL_MS) return cache.targets
    const targets: ModelTarget[] = []
    for (const provider of llm.listProviders()) {
      const models = await llm.listModels(provider.id)
      for (const model of models) targets.push({ provider: provider.id, model: model.id })
    }
    cache = { at: Date.now(), targets }
    return targets
  }

  ctx.on('agent/request', async (payload, next): Promise<LlmCallConfig> => {
    const config = await next()
    if (runtime.mode === 'off' || !runtime.settings.modelRouting.enabled) return config
    const llm = ctx.get('llm')
    if (llm === undefined) {
      runtime.log('warn', 'model routing is enabled but no llm service is mounted')
      return config
    }
    let available: ModelTarget[]
    try {
      available = await listTargets(llm)
    } catch (error) {
      runtime.log('warn', `model catalog unavailable: ${describeThrown(error)}`)
      return config
    }
    const state = runtime.stateFor(payload.agent)
    const result = await runtime.core.routeModel({
      task: state?.snapshot.task ?? '',
      step: state?.snapshot.step ?? '',
      routes: runtime.settings.modelRouting.routes,
      defaultTarget: { provider: config.provider, model: config.model },
      available,
      signal: payload.signal,
      mode: runtime.mode,
    })
    runtime.log('info', `model routing ${result.status}: ${result.reason}`, {
      route: result.route,
      target: `${result.target.provider}/${result.target.model}`,
      current: `${config.provider}/${config.model}`,
      failure: result.failure?.code,
    })
    if (runtime.mode !== 'enforce' || result.status !== 'routed') return config
    return { ...config, provider: result.target.provider, model: result.target.model }
  })
}
