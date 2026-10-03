/**
 * Host-half live-settings integration (rc.1 model).
 *
 * A plugin's editable Config fields are declared `.volatile()`. The Loader
 * wraps each such field in a stable reference, and on a committed settings
 * write it moves the reference and emits `loader/volatile-update`; the plugin
 * re-reads the fields and rebuilds its runtime in place. The test mirrors that
 * contract by constructing the runtime directly with volatile references (the
 * Cordis schema validates plain input, so references cannot ride `ctx.plugin`),
 * moving a reference, emitting the event, and asserting the outcome.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createVolatile, type Volatile } from '@deepseek-ai/cosmokit'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Config } from '../src/config.js'
import { JevRuntime } from '../src/service.js'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    try {
      await ctx.fiber.dispose()
    } catch {
      // Already disposed.
    }
  }
})

const settle = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

/** The shared volatile write protocol (see `@deepseek-ai/cosmokit`). */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** Move one live config reference the way a committed settings write does. */
function commit<T>(ref: Volatile<T>, value: T): void {
  (ref as unknown as Record<symbol, (next: unknown) => void>)[VOLATILE_WRITE](value)
}

async function mount(config: Record<string, unknown>): Promise<{ ctx: Context; runtime: JevRuntime }> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const runtime = new JevRuntime(ctx, config as Config)
  return { ctx, runtime }
}

describe('jev live settings', () => {
  it('reconfigures the running service when a volatile field is committed', async () => {
    const mode = createVolatile<'off' | 'shadow' | 'enforce'>('shadow')
    const { ctx, runtime } = await mount({ provider: 'mock', mode })
    expect(runtime.mode).toBe('shadow')

    commit(mode, 'enforce')
    ctx.emit('loader/volatile-update', [['mode']])
    await settle()
    expect(runtime.mode).toBe('enforce')
  })

  it('reconfigures a nested feature toggle in place', async () => {
    const enabled = createVolatile(true)
    const { ctx, runtime } = await mount({
      provider: 'mock',
      mode: 'shadow',
      selection: { enabled },
      assessment: { enabled: true },
    })
    expect(runtime.settings.selection.enabled).toBe(true)

    commit(enabled, false)
    ctx.emit('loader/volatile-update', [['selection', 'enabled']])
    await settle()
    expect(runtime.settings.selection.enabled).toBe(false)
    // The rest of the configuration stays as composed.
    expect(runtime.settings.assessment.enabled).toBe(true)
  })

  it('keeps the last good configuration when a committed value cannot run', async () => {
    const provider = createVolatile<'mock' | 'live'>('mock')
    const { ctx, runtime } = await mount({ provider, mode: 'shadow' })

    // `live` without an explicit apiKey cannot run; the write is refused.
    commit(provider, 'live')
    ctx.emit('loader/volatile-update', [['provider']])
    await settle()
    expect(runtime.settings.provider).toBe('mock')
  })

  it('keeps running when no settings provider is mounted', async () => {
    const { ctx, runtime } = await mount({ provider: 'mock', mode: 'shadow' })
    expect(runtime.mode).toBe('shadow')
    expect(ctx.get('settings')).toBeUndefined()
  })

  it('aborts in-flight assessments when the configuration changes', async () => {
    const mode = createVolatile<'off' | 'shadow' | 'enforce'>('shadow')
    const { ctx, runtime } = await mount({
      provider: 'mock',
      mode,
      selection: { enabled: false },
      assessment: { enabled: true },
      mock: { delayMs: 5000 },
    })

    const started = runtime.assess({
      task: 'Task',
      toolId: 'read_file',
      arguments: { path: '/a' },
      mode: 'shadow',
    })
    await settle()
    expect(runtime.core.activeRequests).toBe(1)

    commit(mode, 'off')
    ctx.emit('loader/volatile-update', [['mode']])
    const assessment = await started
    expect(assessment.failure?.code).toBe('ABORTED')
    expect(runtime.core.activeRequests).toBe(0)
  })
})
