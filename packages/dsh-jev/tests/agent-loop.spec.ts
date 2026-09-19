/**
 * Full-runtime integration tests: real `@deepseek-ai/dsh-agent-loop`
 * (through its published test harness), real ToolRuntime pipeline, real
 * ApprovalService, and the actual `@buberlo/dsh-jev` plugin. Only the LLM is a
 * deterministic test adapter.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness, type AgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import type { Agent } from '@deepseek-ai/dsh-agent'
import JevPlugin from '../src/index.js'
import type { JevPluginConfig } from '../src/index.js'
import { ScriptedAdapter, textTurn, toolTurn } from './helpers/scripted-adapter.js'

interface Fixture {
  ctx: Context
  harness: AgentLoopTestHarness
  adapter: ScriptedAdapter
  executed: Array<{ tool: string; args: unknown }>
}

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    try {
      await ctx.fiber.dispose()
    } catch {
      // Already disposed by the test itself.
    }
  }
})

function registerReadTool(ctx: Context, executed: Fixture['executed']): void {
  ctx.tools.register({
    name: 'read_file',
    description: 'Read a file from disk.',
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
      executed.push({ tool: 'read_file', args })
      return 'file content'
    },
  })
}

async function mount(
  ctx: Context,
  config: JevPluginConfig,
  options: { approval?: boolean; tools?: Array<'read_file' | 'write_file'> } = {},
): Promise<Fixture> {
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JevPlugin, config)
  if (options.approval === true) await ctx.plugin(ApprovalService, { policy: 'ask' })
  const adapter = new ScriptedAdapter()
  ctx.llm.registerAdapter(['scripted'], adapter)
  const harness = await mountAgentLoopTestHarness(ctx)
  const executed: Fixture['executed'] = []
  const wanted = options.tools ?? ['read_file']
  if (wanted.includes('read_file')) registerReadTool(ctx, executed)
  if (wanted.includes('write_file')) {
    ctx.tools.register({
      name: 'write_file',
      description: 'Write a file to disk.',
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
        executed.push({ tool: 'write_file', args })
        return 'written'
      },
    })
  }
  return { ctx, harness, adapter, executed }
}

async function runTurn(agent: Agent, _harness: AgentLoopTestHarness, text: string): Promise<void> {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
}

function toolFailureTexts(agent: Agent): string[] {
  const texts: string[] = []
  for (const message of agent.session.deriveMessages()) {
    for (const block of message.content) {
      if (block.type === 'tool-result' && block.isError === true) {
        for (const inner of block.content) if (inner.type === 'text') texts.push(inner.text)
      }
    }
  }
  return texts
}

const askAssessmentConfig: JevPluginConfig = {
  provider: 'mock',
  mode: 'enforce',
  selection: { enabled: false },
  assessment: { enabled: true, onFailure: 'ask' },
  mock: {
    answers: {
      matches_task: { noul: 0.95 },
      missing_information: { noul: 0.95 },
      violates_restriction: { noul: 0.05 },
    },
  },
}

const allowAssessmentConfig: JevPluginConfig = {
  ...askAssessmentConfig,
  mock: {
    answers: {
      matches_task: { noul: 0.95 },
      missing_information: { noul: 0.05 },
      violates_restriction: { noul: 0.05 },
    },
  },
}

describe('dsh-jev on the real agent loop', () => {
  it('loads the plugin and exposes ctx.jev', async () => {
    const { ctx } = await mount(new Context(), { provider: 'mock', mode: 'shadow' })
    expect(ctx.jev).toBeDefined()
    expect(ctx.jev.mode).toBe('shadow')
    expect(ctx.jev.core.config.provider.kind).toBe('mock')
  })

  it('enforce + ask assessment without an approval answerer fails closed and never runs the tool', async () => {
    const fixture = await mount(new Context(), askAssessmentConfig)
    const agent = await fixture.harness.create(SessionId('agent-a'), { provider: 'scripted', model: 'scripted-1' })
    fixture.adapter.enqueue('agent-a', toolTurn('read_file', { path: '/a' }), textTurn('done'))
    await runTurn(agent, fixture.harness, 'Read /a')
    expect(fixture.executed).toEqual([])
    expect(fixture.ctx.jev.stats.asks).toBe(1)
    const failures = toolFailureTexts(agent)
    expect(failures.length).toBeGreaterThan(0)
    expect(failures[0]).toContain('[jev]')
  })

  it('enforce + allowed-once approval runs the exact assessed call and stays per-call', async () => {
    const fixture = await mount(new Context(), askAssessmentConfig, { approval: true })
    const approvals: string[] = []
    fixture.ctx.on('approval/request', async (request, _next) => {
      approvals.push(request.toolName)
      return 'allowed-once'
    })
    const agent = await fixture.harness.create(SessionId('agent-b'), { provider: 'scripted', model: 'scripted-1' })
    fixture.adapter.enqueue(
      'agent-b',
      toolTurn('read_file', { path: '/a' }, 'call-1'),
      toolTurn('read_file', { path: '/b' }, 'call-2'),
      textTurn('done'),
    )
    await runTurn(agent, fixture.harness, 'Read /a then /b')
    expect(approvals).toEqual(['read_file', 'read_file'])
    expect(fixture.executed).toEqual([
      { tool: 'read_file', args: { path: '/a' } },
      { tool: 'read_file', args: { path: '/b' } },
    ])
    expect(fixture.ctx.jev.stats.asks).toBe(2)
  })

  it('enforce + allow assessment runs the tool unchanged', async () => {
    const fixture = await mount(new Context(), allowAssessmentConfig)
    const agent = await fixture.harness.create(SessionId('agent-c'), { provider: 'scripted', model: 'scripted-1' })
    fixture.adapter.enqueue('agent-c', toolTurn('read_file', { path: '/a' }), textTurn('done'))
    await runTurn(agent, fixture.harness, 'Read /a')
    expect(fixture.executed).toEqual([{ tool: 'read_file', args: { path: '/a' } }])
    expect(toolFailureTexts(agent)).toEqual([])
  })

  it('shadow assesses and logs without changing behavior', async () => {
    const fixture = await mount(new Context(), { ...askAssessmentConfig, mode: 'shadow' })
    const agent = await fixture.harness.create(SessionId('agent-d'), { provider: 'scripted', model: 'scripted-1' })
    fixture.adapter.enqueue('agent-d', toolTurn('read_file', { path: '/a' }), textTurn('done'))
    await runTurn(agent, fixture.harness, 'Read /a')
    expect(fixture.executed).toHaveLength(1)
    expect(fixture.ctx.jev.stats.assessments).toBeGreaterThan(0)
    expect(fixture.ctx.jev.stats.asks).toBe(0)
  })

  it('off makes no Jev request and leaves behavior untouched', async () => {
    const fixture = await mount(new Context(), { ...askAssessmentConfig, mode: 'off' })
    const agent = await fixture.harness.create(SessionId('agent-e'), { provider: 'scripted', model: 'scripted-1' })
    fixture.adapter.enqueue('agent-e', toolTurn('read_file', { path: '/a' }), textTurn('done'))
    await runTurn(agent, fixture.harness, 'Read /a')
    expect(fixture.executed).toHaveLength(1)
    const provider = fixture.ctx.jev.core.config.provider as { callCount: number }
    expect(provider.callCount).toBe(0)
  })

  it('plugin absent keeps the original behavior (baseline)', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    const adapter = new ScriptedAdapter()
    ctx.llm.registerAdapter(['scripted'], adapter)
    const harness = await mountAgentLoopTestHarness(ctx)
    const executed: Fixture['executed'] = []
    registerReadTool(ctx, executed)
    const agent = await harness.create(SessionId('agent-f'), { provider: 'scripted', model: 'scripted-1' })
    adapter.enqueue('agent-f', toolTurn('read_file', { path: '/a' }), textTurn('done'))
    await runTurn(agent, harness, 'Read /a')
    expect(executed).toHaveLength(1)
  })

  it('applies a tool selection restriction and never widens an existing denial', async () => {
    const config: JevPluginConfig = {
      provider: 'mock',
      mode: 'enforce',
      selection: { enabled: true, alwaysAllow: [] },
      assessment: { enabled: false },
      mock: {
        answers: {
          rel_read_file: { noul: 0.95 },
          rel_write_file: { noul: 0.95 },
          pick_read_file: { choice: 'read_file' },
          pick_write_file: { choice: 'write_file' },
        },
      },
    }
    const fixture = await mount(new Context(), config, { tools: ['read_file', 'write_file'] })
    const agent = await fixture.harness.create(SessionId('agent-g'), { provider: 'scripted', model: 'scripted-1' })
    // Pre-existing permission: write_file is already denied for this agent.
    agent.ctx.tools.restrict({ deny: ['write_file'] })
    fixture.adapter.enqueue('agent-g', textTurn('done'))
    await runTurn(agent, fixture.harness, 'Read and write files')
    const visible = fixture.ctx.tools.schemas(agent).map(schema => schema.name)
    expect(visible).toContain('read_file')
    expect(visible).not.toContain('write_file')
    expect(fixture.ctx.jev.stats.restrictionsApplied).toBe(1)
  })

  it('keeps two parallel sessions isolated', async () => {
    const config: JevPluginConfig = {
      provider: 'mock',
      mode: 'enforce',
      selection: { enabled: true },
      assessment: { enabled: false },
      loopDetection: { enabled: true, maxRepeats: 2 },
      mock: {
        answers: {
          rel_read_file: { noul: 0.95 },
          pick_read_file: { choice: 'read_file' },
        },
      },
    }
    const fixture = await mount(new Context(), config)
    const first = await fixture.harness.create(SessionId('agent-h1'), { provider: 'scripted', model: 'scripted-1' })
    const second = await fixture.harness.create(SessionId('agent-h2'), { provider: 'scripted', model: 'scripted-1' })
    fixture.adapter.enqueue(
      'agent-h1',
      toolTurn('read_file', { path: '/same' }, 'call-1'),
      toolTurn('read_file', { path: '/same' }, 'call-2'),
      toolTurn('read_file', { path: '/same' }, 'call-3'),
      textTurn('done'),
    )
    fixture.adapter.enqueue('agent-h2', toolTurn('read_file', { path: '/same' }, 'call-9'), textTurn('done'))
    await Promise.all([
      runTurn(first, fixture.harness, 'Repeat read'),
      runTurn(second, fixture.harness, 'Single read'),
    ])
    // The first agent's third identical call is denied by its own guard...
    expect(toolFailureTexts(first).join(' ')).toContain('identical read_file')
    // ...while the second agent's identical call still runs: no shared state.
    expect(fixture.executed.filter(entry => (entry.args as { path: string }).path === '/same')).toHaveLength(3)
    expect(fixture.ctx.jev.stats.loopDenials).toBe(1)
  })

  it('disposes without leaving listeners, restrictions, or in-flight requests', async () => {
    const fixture = await mount(new Context(), allowAssessmentConfig)
    const agent = await fixture.harness.create(SessionId('agent-i'), { provider: 'scripted', model: 'scripted-1' })
    fixture.adapter.enqueue('agent-i', textTurn('done'))
    await runTurn(agent, fixture.harness, 'Hello')
    const jev = fixture.ctx.jev
    expect(jev.trackedAgents).toBeGreaterThan(0)

    await fixture.ctx.fiber.dispose()
    expect(jev.trackedAgents).toBe(0)
    expect(jev.core.activeRequests).toBe(0)
  })

  it('applies a verified model route in enforce mode and falls back in shadow', async () => {
    const routed: JevPluginConfig = {
      provider: 'mock',
      mode: 'enforce',
      selection: { enabled: false },
      assessment: { enabled: false },
      modelRouting: { enabled: true, routes: { reasoning: { provider: 'scripted', model: 'scripted-2' } } },
      mock: { answers: { route: { choice: { choice: 'reasoning', confidence: 1 } } } },
    }
    const enforced = await mount(new Context(), routed)
    const agent = await enforced.harness.create(SessionId('agent-j1'), { provider: 'scripted', model: 'scripted-1' })
    enforced.adapter.enqueue('agent-j1', textTurn('done'))
    await runTurn(agent, enforced.harness, 'Prove the invariant')
    expect(enforced.adapter.modelsSeen[0]).toBe('scripted-2')

    const shadowed = await mount(new Context(), { ...routed, mode: 'shadow' })
    const shadowAgent = await shadowed.harness.create(SessionId('agent-j2'), { provider: 'scripted', model: 'scripted-1' })
    shadowed.adapter.enqueue('agent-j2', textTurn('done'))
    await runTurn(shadowAgent, shadowed.harness, 'Prove the invariant')
    expect(shadowed.adapter.modelsSeen[0]).toBe('scripted-1')
  })

  it('falls back to the existing model when the route target is not available', async () => {
    const fixture = await mount(new Context(), {
      provider: 'mock',
      mode: 'enforce',
      selection: { enabled: false },
      assessment: { enabled: false },
      modelRouting: { enabled: true, routes: { reasoning: { provider: 'scripted', model: 'ghost-model' } } },
      mock: { answers: { route: { choice: { choice: 'reasoning', confidence: 1 } } } },
    })
    const agent = await fixture.harness.create(SessionId('agent-k'), { provider: 'scripted', model: 'scripted-1' })
    fixture.adapter.enqueue('agent-k', textTurn('done'))
    await runTurn(agent, fixture.harness, 'Task')
    expect(fixture.adapter.modelsSeen[0]).toBe('scripted-1')
  })

  it('routes a skill and injects only a bounded hint', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(SkillRegistry)
    ctx.skills.register({ name: 'test-runner', description: 'Runs the test suite', content: 'SECRET SKILL BODY' })
    await ctx.plugin(JevPlugin, {
      provider: 'mock',
      mode: 'enforce',
      selection: { enabled: false },
      assessment: { enabled: false },
      skills: { enabled: true, injectHint: true },
      mock: {
        answers: {
          needs_skill: { noul: 0.95 },
          skill: { choice: { choice: 'test-runner', confidence: 1 } },
        },
      },
    })
    const adapter = new ScriptedAdapter()
    ctx.llm.registerAdapter(['scripted'], adapter)
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('agent-l'), { provider: 'scripted', model: 'scripted-1' })
    adapter.enqueue('agent-l', toolTurn('read_file', { path: '/a' }), textTurn('done'))
    ctx.tools.register({
      name: 'read_file',
      description: 'Read a file.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute() { return 'ok' },
    })
    await runTurn(agent, harness, 'Run the tests')
    const injected = adapter.messageTexts.flat().some(text => text.includes('Skill routing suggestion: "test-runner"'))
    expect(injected).toBe(true)
    // Only the hint is injected; the skill body stays out of the model context.
    expect(adapter.messageTexts.flat().some(text => text.includes('SECRET SKILL BODY'))).toBe(false)
  })
})
