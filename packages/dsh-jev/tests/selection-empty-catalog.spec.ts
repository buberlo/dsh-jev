/**
 * Empty selection catalog: selection stays fail-open and warns once per agent.
 *
 * The catalog is the restrictable set: `schemas(agent)` filtered to names
 * `tools.get(name)` resolves globally. Both an agent with no tools and an
 * agent whose only tool is scope-local land on that empty set.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import JevPlugin from '../src/index.js'
import type { JevPluginConfig } from '../src/index.js'

const EMPTY_CATALOG_WARN = '[dsh-jev] tool selection skipped: tool catalog resolved empty for this agent'

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

async function mount(config: JevPluginConfig): Promise<{ ctx: Context; warnings: string[] }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(JevPlugin, config)
  const warnings: string[] = []
  ctx.logger.exporter({
    levels: { default: 3 },
    export(message) {
      if (message.type === 'warn') warnings.push(String(message.args[0]))
    },
  })
  return { ctx, warnings }
}

/**
 * Agent object is the scope key, matching the real loop.
 * The scope is minted from a context that already injects `tools`, so
 * `agent.ctx.tools` can register a scope-local tool.
 */
async function stubAgent(ctx: Context): Promise<Agent> {
  const agent = {
    session: {
      deriveMessages() {
        throw new Error('unused')
      },
    },
  } as unknown as Agent
  await ctx.inject(['tools'], (toolsCtx) => {
    const scope = createScope(toolsCtx, agent)
    Object.assign(agent, { ctx: scope.ctx })
  })
  return agent
}

function registerTool(ctx: Context, name: string): void {
  ctx.tools.register({
    name,
    description: 'A tool visible to this scope.',
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
    async execute() {
      return 'ok'
    },
  })
}

async function preStep(ctx: Context, agent: Agent, step: number): Promise<PreStepDecision> {
  const downstream: PreStepDecision = { kind: 'enter', messages: [] }
  const decision = await ctx.waterfall('agent/pre-step', {
    agent,
    messages: [],
    turn: 1,
    step,
    signal: new AbortController().signal,
  }, async () => downstream)
  expect(decision).toBe(downstream)
  return decision
}

describe('selection with an empty tool catalog', () => {
  it('warns once per agent and leaves the turn on the existing tool set', async () => {
    const { ctx, warnings } = await mount({
      provider: 'mock',
      mode: 'enforce',
      logDecisions: false,
      selection: { enabled: true, alwaysAllow: [] },
      assessment: { enabled: false },
      loopDetection: { enabled: false },
    })

    const bare = await stubAgent(ctx)
    expect(ctx.tools.schemas(bare)).toEqual([])
    await preStep(ctx, bare, 1)
    await preStep(ctx, bare, 2)
    expect(warnings).toEqual([EMPTY_CATALOG_WARN])
    expect(ctx.jev.stats.selections).toBe(0)
    expect(ctx.jev.stats.restrictionsApplied).toBe(0)
    expect(ctx.jev.ensureState(bare).hasSelectionRestriction).toBe(false)
    const provider = ctx.jev.core.config.provider as { callCount: number }
    expect(provider.callCount).toBe(0)

    const scoped = await stubAgent(ctx)
    registerTool(scoped.ctx, 'local_note')
    expect(ctx.tools.schemas(scoped).map(schema => schema.name)).toEqual(['local_note'])
    expect(ctx.tools.get('local_note')).toBeUndefined()
    await preStep(ctx, scoped, 1)
    await preStep(ctx, scoped, 2)
    expect(warnings).toEqual([EMPTY_CATALOG_WARN, EMPTY_CATALOG_WARN])
    expect(ctx.tools.schemas(scoped).map(schema => schema.name)).toEqual(['local_note'])
    expect(ctx.tools.get('local_note')).toBeUndefined()
    expect(ctx.jev.stats.selections).toBe(0)
    expect(ctx.jev.stats.restrictionsApplied).toBe(0)
    expect(ctx.jev.ensureState(scoped).hasSelectionRestriction).toBe(false)
    expect(provider.callCount).toBe(0)
  })

  it('stays silent when selection is disabled', async () => {
    const { ctx, warnings } = await mount({
      provider: 'mock',
      mode: 'enforce',
      selection: { enabled: false },
      assessment: { enabled: false },
      loopDetection: { enabled: false },
    })
    const agent = await stubAgent(ctx)
    await preStep(ctx, agent, 1)
    await preStep(ctx, agent, 2)
    expect(warnings).toEqual([])
    expect(ctx.jev.stats.selections).toBe(0)
  })

  it('does not emit the empty-catalog warning when a global tool is visible', async () => {
    const { ctx, warnings } = await mount({
      provider: 'mock',
      mode: 'shadow',
      selection: { enabled: true, alwaysAllow: [] },
      assessment: { enabled: false },
      loopDetection: { enabled: false },
      mock: {
        answers: {
          rel_read_file: { noul: 0.95 },
          pick_read_file: { choice: 'read_file' },
        },
      },
    })
    registerTool(ctx, 'read_file')
    const agent = await stubAgent(ctx)
    expect(ctx.tools.schemas(agent).map(schema => schema.name)).toEqual(['read_file'])
    expect(ctx.tools.get('read_file')).toBeDefined()
    await preStep(ctx, agent, 1)
    expect(warnings).toEqual([])
    expect(ctx.jev.stats.selections).toBe(1)
  })
})
