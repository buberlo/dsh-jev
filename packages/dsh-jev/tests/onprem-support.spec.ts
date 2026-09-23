/**
 * Labeled on-prem Kubernetes support regression.
 *
 * Mock answers exercise the real `tools/pre-execute` gate. They do not
 * measure Jev. The same fixtures drive `pnpm evals` (mock by default;
 * `--live` only with an explicit key).
 */

import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { DEFAULT_LIMITS, type MockAnswerSpec, type MockJevProvider } from '@buberlo/jev-core'
import { loadOnpremFixtures, type OnpremSupportFixture } from '../../../scripts/lib/fixtures.ts'
import JevPlugin from '../src/index.js'
import type { JevPluginConfig } from '../src/index.js'
import {
  INCIDENT_SUMMARY_MAX_CHARS,
  KUBERNETES_SITE_RESTRICTION,
  rejectOversizedIncidentSummary,
} from '../src/usecases/kubernetes-support.js'

const fixtures = loadOnpremFixtures()

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

interface Effect {
  tool: string
  args: unknown
}

interface Harness {
  ctx: Context
  agent: Agent
  effects: Effect[]
}

function outputSchema() {
  return {
    schema: { type: 'string' as const },
    render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: String(value) }],
  }
}

function registerSupportTools(ctx: Context, effects: Effect[]): void {
  ctx.tools.register({
    name: 'kubectl_get',
    description: 'Read Kubernetes resources in the named namespace. Does not modify them.',
    parameters: {
      type: 'object',
      properties: {
        namespace: { type: 'string' },
        resources: { type: 'string' },
        view: { type: 'string' },
      },
      additionalProperties: false,
    },
    output: outputSchema(),
    async execute(args) {
      effects.push({ tool: 'kubectl_get', args })
      return 'ok'
    },
  })
  ctx.tools.register({
    name: 'kubectl_patch',
    description: 'Patch one namespaced Kubernetes resource. The patch is a JSON string.',
    parameters: {
      type: 'object',
      properties: {
        namespace: { type: 'string' },
        resource: { type: 'string' },
        name: { type: 'string' },
        patch: { type: 'string' },
      },
      additionalProperties: false,
    },
    output: outputSchema(),
    async execute(args) {
      effects.push({ tool: 'kubectl_patch', args })
      return 'patched'
    },
  })
  ctx.tools.register({
    name: 'probe_connectivity',
    description: 'Read-only HTTP and TCP checks for the named namespace.',
    parameters: {
      type: 'object',
      properties: {
        namespace: { type: 'string' },
      },
      additionalProperties: false,
    },
    output: outputSchema(),
    async execute(args) {
      effects.push({ tool: 'probe_connectivity', args })
      return 'probed'
    },
  })
  ctx.tools.register({
    name: 'write_incident_summary',
    description: 'Record an incident summary. The tool rejects summaries over its contract length.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string' },
      },
      required: ['content'],
      additionalProperties: false,
    },
    output: outputSchema(),
    async execute(args) {
      const content = typeof args.content === 'string' ? args.content : ''
      const rejection = rejectOversizedIncidentSummary(content)
      if (rejection !== undefined) throw new Error(rejection)
      effects.push({ tool: 'write_incident_summary', args })
      return 'Incident summary recorded'
    },
  })
}

async function setup(
  answers: Record<string, MockAnswerSpec>,
  restrictions: readonly string[],
  onFailure?: 'ask' | 'hold',
): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const config: JevPluginConfig = {
    provider: 'mock',
    mode: 'enforce',
    logDecisions: false,
    selection: { enabled: false },
    loopDetection: { enabled: false },
    assessment: {
      enabled: true,
      restrictions: [...restrictions],
      ...(onFailure === undefined ? {} : { onFailure }),
    },
    mock: { answers },
  }
  await ctx.plugin(JevPlugin, config)
  const effects: Effect[] = []
  registerSupportTools(ctx, effects)
  const key = {}
  const scope = createScope(ctx, key)
  const agent = { ctx: scope.ctx, session: {} } as unknown as Agent
  ctx.jev.ensureState(agent).updateSnapshot({ task: 'pending', step: '', turn: 1 })
  return { ctx, agent, effects }
}

async function execute(harness: Harness, fixture: Pick<OnpremSupportFixture, 'id' | 'toolId' | 'arguments' | 'task'>) {
  harness.ctx.jev.ensureState(harness.agent).updateSnapshot({ task: fixture.task, step: '', turn: 1 })
  return harness.ctx.tools.execute({
    callId: ToolCallId(fixture.id),
    name: fixture.toolId,
    arguments: fixture.arguments,
    agent: harness.agent,
    signal: new AbortController().signal,
  })
}

function providerOf(harness: Harness): MockJevProvider {
  return harness.ctx.jev.core.config.provider as MockJevProvider
}

describe('on-prem support assessments', () => {
  it('keeps an accepted incident summary inside the default assessment bound', () => {
    expect(INCIDENT_SUMMARY_MAX_CHARS).toBe(900)
    expect(DEFAULT_LIMITS.maxArgumentChars).toBe(1200)
    const accepted = JSON.stringify({ content: 'x'.repeat(INCIDENT_SUMMARY_MAX_CHARS) })
    expect(accepted.length).toBeLessThanOrEqual(DEFAULT_LIMITS.maxArgumentChars)
    const fixturePath = fileURLToPath(new URL('../../../evals/fixtures/onprem-support.v1.jsonl', import.meta.url))
    expect(readFileSync(fixturePath, 'utf8').length).toBeGreaterThan(0)
    for (const fixture of fixtures) {
      expect(fixture.restrictions).toEqual([KUBERNETES_SITE_RESTRICTION])
    }
  })

  it.each(fixtures.map(fixture => [fixture.id, fixture] as const))(
    '%s follows the labeled gate decision',
    async (_id, fixture) => {
      const harness = await setup(fixture.answers, fixture.restrictions)
      const result = await execute(harness, fixture)
      const provider = providerOf(harness)

      if (fixture.scope === 'explicit') {
        expect(fixture.arguments.namespace).toEqual(expect.any(String))
      }
      if (fixture.scope === 'missing') {
        expect(fixture.arguments).not.toHaveProperty('namespace')
      }

      if (fixture.expect.incomplete === true) {
        expect(provider.callCount).toBe(0)
        expect(provider.requests).toEqual([])
        expect(harness.effects).toEqual([])
        expect(result.isError).toBe(true)
        if (result.isError) expect(result.error.message).toContain('assessment.incomplete-input')
        expect(harness.ctx.jev.stats.assessmentFailures).toBe(1)
        expect(harness.ctx.jev.stats.asks).toBe(1)
        expect(harness.ctx.jev.stats.denials).toBe(0)
        return
      }

      expect(provider.callCount).toBe(1)
      const sent = JSON.stringify(provider.requests)
      expect(sent).not.toContain('…[truncated]')
      expect(sent).not.toContain('[depth limit]')
      if (fixture.scope === 'explicit') expect(sent).toContain(String(fixture.arguments.namespace))
      if (typeof fixture.arguments.content === 'string') {
        expect(sent).toContain(fixture.arguments.content.slice(-8))
      }

      if (fixture.expect.executed) {
        expect(result.isError).toBe(false)
        expect(harness.effects.map(effect => effect.tool)).toEqual([fixture.toolId])
        return
      }

      expect(harness.effects).toEqual([])
      expect(result.isError).toBe(true)
      if (!result.isError) return
      if (fixture.expect.status === 'allow') {
        expect(result.error.message).toContain(`at most ${INCIDENT_SUMMARY_MAX_CHARS}`)
        expect(harness.ctx.jev.stats.denials).toBe(0)
        expect(harness.ctx.jev.stats.asks).toBe(0)
        return
      }
      if (fixture.expect.rule !== undefined) expect(result.error.message).toContain(fixture.expect.rule)
      if (fixture.expect.status === 'deny') expect(harness.ctx.jev.stats.denials).toBe(1)
      if (fixture.expect.status === 'ask') {
        expect(harness.ctx.jev.stats.asks).toBe(1)
        expect(harness.ctx.jev.stats.denials).toBe(0)
      }
    },
  )

  it('records a summary at the contract limit and transmits it whole', async () => {
    const content = `${'Synthetic INC-204 note. '.repeat(40)}BOUND900`.slice(-INCIDENT_SUMMARY_MAX_CHARS)
    expect(content).toHaveLength(INCIDENT_SUMMARY_MAX_CHARS)
    expect(content.endsWith('BOUND900')).toBe(true)
    const fixture = fixtures.find(item => item.id === 'k8s-en-011')
    if (fixture === undefined) throw new Error('missing k8s-en-011')
    const harness = await setup(fixture.answers, fixture.restrictions)
    const result = await execute(harness, {
      id: 'boundary-900',
      toolId: 'write_incident_summary',
      task: fixture.task,
      arguments: { content },
    })
    expect(result.isError).toBe(false)
    expect(harness.effects).toHaveLength(1)
    const sent = JSON.stringify(providerOf(harness).requests)
    expect(sent).toContain('BOUND900')
    expect(sent).not.toContain('…[truncated]')
  })

  it('rejects a summary one character over the contract without truncating the assessment', async () => {
    const content = `${'y'.repeat(INCIDENT_SUMMARY_MAX_CHARS)}Z`
    expect(content).toHaveLength(INCIDENT_SUMMARY_MAX_CHARS + 1)
    expect(JSON.stringify({ content }).length).toBeLessThanOrEqual(DEFAULT_LIMITS.maxArgumentChars)
    const fixture = fixtures.find(item => item.id === 'k8s-en-011')
    if (fixture === undefined) throw new Error('missing k8s-en-011')
    const harness = await setup(fixture.answers, fixture.restrictions)
    const result = await execute(harness, {
      id: 'boundary-901',
      toolId: 'write_incident_summary',
      task: fixture.task,
      arguments: { content },
    })
    expect(harness.effects).toEqual([])
    expect(result.isError).toBe(true)
    if (result.isError) expect(result.error.message).toContain(`at most ${INCIDENT_SUMMARY_MAX_CHARS}`)
    const sent = JSON.stringify(providerOf(harness).requests)
    expect(sent).toContain(`${'y'.repeat(8)}Z`)
    expect(sent).not.toContain('…[truncated]')
  })

  it('holds an oversized report when the failure policy is hold', async () => {
    const fixture = fixtures.find(item => item.id === 'k8s-en-013')
    if (fixture === undefined) throw new Error('missing k8s-en-013')
    const harness = await setup(fixture.answers, fixture.restrictions, 'hold')
    const result = await execute(harness, fixture)
    expect(providerOf(harness).callCount).toBe(0)
    expect(harness.effects).toEqual([])
    expect(result.isError).toBe(true)
    if (result.isError) expect(result.error.message).toContain('tool call aborted before dispatch')
    expect(harness.ctx.jev.stats.holds).toBe(1)
    expect(harness.ctx.jev.stats.assessmentFailures).toBe(1)
    expect(harness.ctx.jev.stats.denials).toBe(0)
    expect(harness.ctx.jev.stats.asks).toBe(0)
  })

  it('fails closed on the real gate when the assessment reply is incomplete', async () => {
    const fixture = fixtures.find(item => item.id === 'k8s-en-001')
    if (fixture === undefined) throw new Error('missing k8s-en-001')
    const harness = await setup({ matches_task: { omit: true } }, fixture.restrictions)
    const result = await execute(harness, fixture)
    expect(providerOf(harness).callCount).toBe(1)
    expect(harness.effects).toEqual([])
    expect(result.isError).toBe(true)
    if (result.isError) expect(result.error.message).toContain('assessment.failure.ask')
    expect(harness.ctx.jev.stats.assessmentFailures).toBe(1)
    expect(harness.ctx.jev.stats.asks).toBe(1)
    expect(harness.ctx.jev.stats.denials).toBe(0)
  })

  it('still denies a deny-all reset when the model reports a restriction violation', async () => {
    const fixture = fixtures.find(item => item.id === 'k8s-en-008')
    if (fixture === undefined) throw new Error('missing k8s-en-008')
    const harness = await setup({
      matches_task: { noul: 0.9 },
      missing_information: { noul: 0.1 },
      violates_restriction: { noul: 0.94 },
    }, fixture.restrictions)
    const result = await execute(harness, fixture)
    expect(harness.effects).toEqual([])
    expect(result.isError).toBe(true)
    if (result.isError) expect(result.error.message).toContain('assessment.restriction-violation')
    expect(harness.ctx.jev.stats.denials).toBe(1)
  })

  it('preserves a downstream pre-execute denial before composing an allow', async () => {
    const fixture = fixtures.find(item => item.id === 'k8s-en-001')
    if (fixture === undefined) throw new Error('missing k8s-en-001')
    const harness = await setup(fixture.answers, fixture.restrictions)
    harness.ctx.on('tools/pre-execute', async () => ({ kind: 'deny', reason: 'downstream policy' }))
    const result = await execute(harness, fixture)
    expect(providerOf(harness).callCount).toBe(0)
    expect(harness.effects).toEqual([])
    expect(result.isError).toBe(true)
    if (result.isError) {
      expect(result.error.message).toContain('downstream policy')
      expect(result.error.message).not.toContain('[jev]')
    }
  })
})
