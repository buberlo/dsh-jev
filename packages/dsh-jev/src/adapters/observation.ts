/**
 * Result observation and deterministic loop detection.
 *
 * `tools/result` is observe-only: it counts outcomes and never touches the
 * immutable final result. A synchronous tool guard (no Jev, no I/O) denies a
 * further identical call once the bounded counter reaches its limit.
 *
 * @module dsh-jev/adapters/observation
 */

import type { Context } from '@deepseek-ai/cordis'
import { stableStringify } from '@buberlo/jev-core'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { JevRuntime } from '../service.js'

/** Install the observe-only listener, the deterministic guard, and the reset hook. */
export function installObservationAdapter(ctx: Context, runtime: JevRuntime): void {
  if (!runtime.settings.loopDetection.enabled) return

  ctx.on('tools/result', (exec) => {
    if (exec.agent === undefined) return
    const observation = runtime.detector.observe(exec.agent, callKey(runtime, exec))
    if (observation.count === runtime.settings.loopDetection.maxRepeats) {
      runtime.log('warn', `possible tool loop: ${exec.name} repeated ${observation.count} times with identical arguments`, {
        tool: exec.name,
        count: observation.count,
      })
    }
  })

  // A new user message is a new context: repetition across it is not a loop.
  ctx.on('agent/pre-step', ({ agent, messages }, next) => {
    if (messages.some(message => message.source.kind === 'user')) runtime.detector.reset(agent)
    return next()
  })

  // Monotonic synchronous guard: registered as an effect so plugin disposal
  // removes it, and it can only deny — never allow.
  ctx.effect(() => {
    const dispose = ctx.tools.guard((exec) => {
      if (runtime.mode !== 'enforce') return undefined
      if (exec.agent === undefined) return undefined
      const count = runtime.detector.peek(exec.agent, callKey(runtime, exec))
      if (count < runtime.settings.loopDetection.maxRepeats) return undefined
      runtime.stats.loopDenials += 1
      runtime.log('warn', `loop guard denied ${exec.name}`, { tool: exec.name, count })
      return `[jev] identical ${exec.name} call already completed ${count} times; change the arguments or the approach before retrying`
    })
    return () => dispose()
  }, 'dsh-jev loop guard')
}

/** Stable identity of one call: tool id plus bounded, canonical arguments. */
function callKey(runtime: JevRuntime, exec: Readonly<ToolExecution>): string {
  return `${exec.name}\u0000${stableStringify(exec.arguments, runtime.core.boundOptions)}`
}
