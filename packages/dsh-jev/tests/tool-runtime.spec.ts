/**
 * Tool-pipeline integration tests against the real `@deepseek-ai/dsh-tools`
 * registry: the actual `tools/pre-execute` waterfall, the real monotonic
 * guard, and real scoped restrictions. The agent is a stub carrying a real
 * scoped context (`createScope`), which is exactly what the loop provides.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import type { MockJevProvider } from '@buberlo/jev-core'
import JevPlugin from '../src/index.js'
import type { JevPluginConfig } from '../src/index.js'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    try {
      await ctx.fiber.dispose()
    } catch {
      // Already disposed by the test.
    }
  }
})

interface Harness {
  ctx: Context
  agent: Agent
  executed: unknown[]
}

async function setup(config: JevPluginConfig): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(JevPlugin, config)
  const key = {}
  const scope = createScope(ctx, key)
  const executed: unknown[] = []
  ctx.tools.register({
    name: 'read_file',
    description: 'Read a file.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      executed.push(args)
      return 'ok'
    },
  })
  const agent = { ctx: scope.ctx, session: {} } as unknown as Agent
  return { ctx, agent, executed }
}

async function execute(
  harness: Harness,
  args: Record<string, unknown>,
  options: { parent?: ToolExecutionToken; callId?: string } = {},
) {
  return harness.ctx.tools.execute({
    callId: ToolCallId(options.callId ?? 'call-1'),
    name: 'read_file',
    arguments: args,
    agent: harness.agent,
    ...(options.parent === undefined ? {} : { parent: options.parent }),
    signal: new AbortController().signal,
  })
}

function mockAnswers(missing: number, violates = 0.05) {
  return {
    matches_task: { noul: 0.95 },
    missing_information: { noul: missing },
    violates_restriction: { noul: violates },
  }
}

describe('dsh-jev on the real tool pipeline', () => {
  it('runs a direct model call through assessment and allows it', async () => {
    const harness = await setup({
      provider: 'mock',
      mode: 'enforce',
      selection: { enabled: false },
      mock: { answers: mockAnswers(0.05) },
    })
    harness.ctx.jev.ensureState(harness.agent).updateSnapshot({ task: 'Read the config', step: '', turn: 1 })
    const result = await execute(harness, { path: '/config' })
    expect(result.isError).toBe(false)
    expect(harness.executed).toEqual([{ path: '/config' }])
    expect(harness.ctx.jev.stats.assessments).toBe(1)
  })

  it('assesses nested (code-mode-style) sub-dispatches through the same gate', async () => {
    const harness = await setup({
      provider: 'mock',
      mode: 'enforce',
      selection: { enabled: false },
      mock: { answers: mockAnswers(0.95) },
    })
    harness.ctx.jev.ensureState(harness.agent).updateSnapshot({ task: 'Read the config', step: '', turn: 1 })
    const parent = Symbol('parent') as unknown as ToolExecutionToken
    const result = await execute(harness, { path: '/config' }, { parent })
    // The nested call traverses the same pre-execute assessment and is gated.
    expect(result.isError).toBe(true)
    expect(harness.executed).toEqual([])
    expect(harness.ctx.jev.stats.asks).toBe(1)
  })

  it('assesses every call separately when arguments change', async () => {
    const harness = await setup({
      provider: 'mock',
      mode: 'enforce',
      selection: { enabled: false },
      mock: { answers: mockAnswers(0.05) },
    })
    harness.ctx.jev.ensureState(harness.agent).updateSnapshot({ task: 'Read files', step: '', turn: 1 })
    await execute(harness, { path: '/a' }, { callId: 'call-1' })
    await execute(harness, { path: '/b' }, { callId: 'call-2' })
    const provider = harness.ctx.jev.core.config.provider as MockJevProvider
    expect(provider.callCount).toBe(2)
    expect(harness.executed).toEqual([{ path: '/a' }, { path: '/b' }])
  })

  it('discards an assessment whose snapshot changed while it was in flight', async () => {
    const harness = await setup({
      provider: 'mock',
      mode: 'enforce',
      selection: { enabled: false },
      mock: { answers: mockAnswers(0.05), delayMs: 60 },
    })
    const state = harness.ctx.jev.ensureState(harness.agent)
    state.updateSnapshot({ task: 'First task', step: '', turn: 1 })
    const pending = execute(harness, { path: '/a' })
    await new Promise(resolve => setTimeout(resolve, 10))
    state.updateSnapshot({ task: 'Second task', step: '', turn: 2 })
    const result = await pending
    expect(harness.ctx.jev.stats.staleDiscarded).toBe(1)
    // Fail-closed: the stale result is discarded and the failure action applies.
    expect(result.isError).toBe(true)
    expect(harness.executed).toEqual([])
  })

  it('fails closed when the assessment has no usable answers', async () => {
    const harness = await setup({
      provider: 'mock',
      mode: 'enforce',
      selection: { enabled: false },
      assessment: { enabled: true, onFailure: 'hold' },
      mock: { answers: { matches_task: { omit: true } } },
    })
    harness.ctx.jev.ensureState(harness.agent).updateSnapshot({ task: 'Task', step: '', turn: 1 })
    const result = await execute(harness, { path: '/a' })
    expect(result.isError).toBe(true)
    expect(harness.executed).toEqual([])
    expect(harness.ctx.jev.stats.assessmentFailures).toBe(1)
  })

  it('makes no provider call in off mode', async () => {
    const harness = await setup({
      provider: 'mock',
      mode: 'off',
      selection: { enabled: false },
      mock: { answers: mockAnswers(0.95) },
    })
    harness.ctx.jev.ensureState(harness.agent).updateSnapshot({ task: 'Task', step: '', turn: 1 })
    const result = await execute(harness, { path: '/a' })
    expect(result.isError).toBe(false)
    expect(harness.executed).toHaveLength(1)
    const provider = harness.ctx.jev.core.config.provider as MockJevProvider
    expect(provider.callCount).toBe(0)
  })

  it('leaves calls without an agent untouched', async () => {
    const harness = await setup({
      provider: 'mock',
      mode: 'enforce',
      selection: { enabled: false },
      mock: { answers: mockAnswers(0.95) },
    })
    const result = await harness.ctx.tools.execute({
      callId: ToolCallId('no-agent'),
      name: 'read_file',
      arguments: { path: '/a' },
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(false)
    expect(harness.ctx.jev.stats.assessments).toBe(0)
  })

  it('aborts an in-flight assessment when the agent is disposed', async () => {
    const harness = await setup({
      provider: 'mock',
      mode: 'enforce',
      selection: { enabled: false },
      mock: { answers: mockAnswers(0.05), delayMs: 5000 },
    })
    const state = harness.ctx.jev.ensureState(harness.agent)
    state.updateSnapshot({ task: 'Task', step: '', turn: 1 })
    const pending = execute(harness, { path: '/a' })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(state.inFlightCount).toBe(1)
    harness.ctx.jev.disposeAgent(harness.agent)
    expect(state.inFlightCount).toBe(0)
    const result = await pending
    expect(result.isError).toBe(true)
    expect(harness.executed).toEqual([])
  })

  it('denies repeated identical calls through the deterministic loop guard in enforce mode', async () => {
    const harness = await setup({
      provider: 'mock',
      mode: 'enforce',
      selection: { enabled: false },
      assessment: { enabled: false },
      loopDetection: { enabled: true, maxRepeats: 2 },
    })
    harness.ctx.jev.ensureState(harness.agent).updateSnapshot({ task: 'Task', step: '', turn: 1 })
    const first = await execute(harness, { path: '/same' }, { callId: 'call-1' })
    const second = await execute(harness, { path: '/same' }, { callId: 'call-2' })
    const third = await execute(harness, { path: '/same' }, { callId: 'call-3' })
    expect(first.isError).toBe(false)
    expect(second.isError).toBe(false)
    expect(third.isError).toBe(true)
    if (third.isError) {
      expect(third.error.message).toContain('identical read_file')
    }
    expect(harness.executed).toHaveLength(2)
    expect(harness.ctx.jev.stats.loopDenials).toBe(1)
  })

  it('does not deny repeats in shadow mode', async () => {
    const harness = await setup({
      provider: 'mock',
      mode: 'shadow',
      selection: { enabled: false },
      assessment: { enabled: false },
      loopDetection: { enabled: true, maxRepeats: 2 },
    })
    harness.ctx.jev.ensureState(harness.agent).updateSnapshot({ task: 'Task', step: '', turn: 1 })
    await execute(harness, { path: '/same' }, { callId: 'call-1' })
    await execute(harness, { path: '/same' }, { callId: 'call-2' })
    const third = await execute(harness, { path: '/same' }, { callId: 'call-3' })
    expect(third.isError).toBe(false)
    expect(harness.executed).toHaveLength(3)
  })
})
