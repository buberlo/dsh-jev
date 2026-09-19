/**
 * Host-half settings integration: the `jev` namespace is registered, and a
 * committed write reconfigures the running service (mode and feature toggles)
 * without a plugin reload. Uses the real file-backed settings provider.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SettingsFile from '@deepseek-ai/dsh-settings-file'
import JevPlugin from '../src/index.js'

const contexts: Context[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    try {
      await ctx.fiber.dispose()
    } catch {
      // Already disposed.
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const settle = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

async function mount() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-jev-settings-'))
  dirs.push(dir)
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SettingsFile, { path: join(dir, 'settings.yaml'), watch: false })
  await ctx.plugin(JevPlugin, {
    provider: 'mock',
    mode: 'shadow',
    selection: { enabled: true },
    assessment: { enabled: true },
    loopDetection: { enabled: true },
  })
  return ctx
}

describe('jev settings section', () => {
  it('registers the namespace with the composed entry as base', async () => {
    const ctx = await mount()
    const section = ctx.settings.get('jev') as { mode?: string; provider?: string } | undefined
    expect(section).toBeDefined()
    expect(section?.mode).toBe('shadow')
    expect(section?.provider).toBe('mock')
  })

  it('reconfigures the running service on a committed write', async () => {
    const ctx = await mount()
    expect(ctx.jev.mode).toBe('shadow')

    await ctx.settings.update('jev', { mode: 'enforce' })
    await settle()
    expect(ctx.jev.mode).toBe('enforce')

    await ctx.settings.update('jev', { selection: { enabled: false } })
    await settle()
    expect(ctx.jev.settings.selection.enabled).toBe(false)
    // The rest of the configuration stays as composed.
    expect(ctx.jev.settings.assessment.enabled).toBe(true)
  })

  it('rejects an invalid value and keeps the last good configuration', async () => {
    const ctx = await mount()
    await expect(ctx.settings.update('jev', { mode: 'bogus' })).rejects.toThrow()
    await settle()
    expect(ctx.jev.mode).toBe('shadow')
  })

  it('switches to the live provider only with a key, and keeps the runtime consistent', async () => {
    const ctx = await mount()
    await expect(ctx.settings.update('jev', { provider: 'live' })).rejects.toThrow(/apiKey/)
    await settle()
    expect(ctx.jev.settings.provider).toBe('mock')

    await ctx.settings.update('jev', { provider: 'live', apiKey: 'test-key-not-real' })
    await settle()
    expect(ctx.jev.settings.provider).toBe('live')
    expect(ctx.jev.core.config.provider.kind).toBe('live')

    await ctx.settings.update('jev', { provider: 'mock' })
    await settle()
    expect(ctx.jev.settings.provider).toBe('mock')
  })

  it('keeps running when the settings provider is absent', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(JevPlugin, { provider: 'mock', mode: 'shadow' })
    expect(ctx.jev.mode).toBe('shadow')
    expect(ctx.get('settings')).toBeUndefined()
  })

  it('aborts in-flight assessments when the configuration changes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-jev-reconfig-'))
    dirs.push(dir)
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(SettingsFile, { path: join(dir, 'settings.yaml'), watch: false })
    await ctx.plugin(JevPlugin, {
      provider: 'mock',
      mode: 'shadow',
      selection: { enabled: false },
      assessment: { enabled: true },
      mock: { delayMs: 5000 },
    })

    const started = ctx.jev.assess({
      task: 'Task',
      toolId: 'read_file',
      arguments: { path: '/a' },
      mode: 'shadow',
    })
    await settle()
    expect(ctx.jev.core.activeRequests).toBe(1)

    await ctx.settings.update('jev', { mode: 'off' })
    const assessment = await started
    expect(assessment.failure?.code).toBe('ABORTED')
    expect(ctx.jev.core.activeRequests).toBe(0)
  })
})
