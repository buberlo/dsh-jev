/**
 * Real-DSH-runtime example (offline, synthetic).
 *
 * Mounts the actual published DSH services — `@deepseek-ai/dsh-system-prompt`
 * and `@deepseek-ai/dsh-tools` — and the real `@buberlo/dsh-jev` plugin, then
 * dispatches tool calls through the genuine `tools/pre-execute` pipeline.
 * This is not a mock event system: the decisions below travel the same
 * registry path the agent loop uses.
 *
 * Model answers are SYNTHETIC (deterministic mock provider); execution is
 * simulated (the synthetic tool only records that it ran).
 *
 * Run: pnpm example:dsh   (build the workspace first: pnpm build)
 */

import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import JevPlugin, { type JevPluginConfig } from '@buberlo/dsh-jev'

const executed: string[] = []

const config: JevPluginConfig = {
  provider: 'mock',
  mode: 'enforce',
  selection: { enabled: false },
  assessment: { enabled: true, onFailure: 'ask' },
  mock: {
    answers: {
      matches_task: { noul: 0.95 },
      // The synthetic "model" thinks information is missing for this call.
      missing_information: { noul: 0.92 },
      violates_restriction: { noul: 0.05 },
    },
  },
}

const readTool: ToolDefinition = {
  name: 'read_file',
  description: 'Synthetic read-only tool (no real filesystem access).',
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
    executed.push(JSON.stringify(args))
    return `synthetic content of ${String((args as { path: string }).path)}`
  },
}

async function main(): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(JevPlugin, config)
  ctx.tools.register(readTool)

  const scope = createScope(ctx, {})
  const agent = { ctx: scope.ctx, session: {} } as unknown as Agent
  ctx.jev.ensureState(agent).updateSnapshot({
    task: 'Inspect the deployment configuration before changing anything',
    step: 'read the config',
    turn: 1,
  })

  console.log('=== dsh-jev on the real DSH tool pipeline ===')
  console.log(`plugin mode : ${ctx.jev.mode}`)
  console.log(`provider    : ${ctx.jev.core.config.provider.kind} (model: mock/jev-synthetic, SYNTHETIC answers)`)

  const first = await ctx.tools.execute({
    callId: ToolCallId('example-1'),
    name: 'read_file',
    arguments: { path: '/repo/config.yml' },
    agent,
    signal: new AbortController().signal,
  })
  console.log('\ncall 1: read_file { path: "/repo/config.yml" }')
  console.log(`  pipeline result : ${first.isError ? 'ERROR' : 'success'}`)
  if (first.isError) console.log(`  model sees      : ${first.error.message}`)
  console.log(`  tool executed   : ${executed.length > 0}`)
  console.log('  effect          : approval requested; without an approval answerer DSH fails closed')

  // Same tool, a different assessment state: replace the synthetic scenario by
  // mounting a second context would be heavier than this example needs, so the
  // second call demonstrates the per-call binding instead: a changed call gets
  // its own assessment and its own signature.
  const second = await ctx.tools.execute({
    callId: ToolCallId('example-2'),
    name: 'read_file',
    arguments: { path: '/repo/other.yml' },
    agent,
    signal: new AbortController().signal,
  })
  console.log('\ncall 2: read_file { path: "/repo/other.yml" } (different arguments)')
  console.log(`  pipeline result : ${second.isError ? 'ERROR' : 'success'} (assessed again, nothing cached)`)
  console.log(`  tool executed   : ${executed.length > 0}`)

  console.log('\nstats:', JSON.stringify(ctx.jev.stats))
  console.log('\nAll model values above are SYNTHETIC; no network request was made.')
  await ctx.fiber.dispose()
}

await main()
