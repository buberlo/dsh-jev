/**
 * Deterministic comparison: the real DSH agent loop and the real plugin, with
 * a scripted model ("recording as code"). This isolates what Jev changes:
 *
 * - A  baseline, no plugin
 * - B  plugin, mock + shadow   (integration overhead; decisions logged only)
 * - C  plugin, mock + enforce  (selection narrows the visible tools, assessment gates)
 * - D  plugin, live + shadow   (real Jev latency; only when TYPESAFE_API_KEY is set)
 *
 * What it can show: tool-schema bytes sent to the model, executed vs avoided
 * tool calls, turn wall-clock, decision counts, and the measured Jev overhead.
 * What it cannot show: how a real model would turn smaller prompts into lower
 * latency. That needs a real LLM tier (`scripts/bench-cli.mjs`).
 *
 * Run: pnpm bench:compare
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import JevPlugin, { type JevPluginConfig } from '../src/index.js'
import { ScriptedAdapter, textTurn, toolTurn } from '../tests/helpers/scripted-adapter.js'

const REPETITIONS = 25
const LIVE_REPETITIONS = 10
const CALL = toolTurn('read_file', { path: '/sandbox/notes.txt' }, 'call-1')
const FINISH = textTurn('done')

/** Records request sizes; everything else behaves like the shared scripted adapter. */
class MeasuringAdapter extends ScriptedAdapter {
  toolsBytes = 0
  messagesBytes = 0
  requestCount = 0

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.purpose === undefined) {
      this.toolsBytes += (options.tools ?? []).reduce((sum, tool) => sum + JSON.stringify(tool).length, 0)
      this.messagesBytes += options.messages.reduce((sum, message) => sum + JSON.stringify(message.content).length, 0)
      this.requestCount += 1
    }
    yield* super.stream(options)
  }
}

interface VariantMetrics {
  wallMs: number
  toolsBytes: number
  messagesBytes: number
  modelRequests: number
  toolExecutions: number
  selections: number
  assessments: number
  asks: number
  holds: number
  denials: number
  restrictionsApplied: number
}

const TOOLS: Array<{ name: string; description: string }> = [
  { name: 'read_file', description: 'Read a file from the sandbox workspace' },
  { name: 'write_file', description: 'Write a file in the sandbox workspace' },
  { name: 'run_tests', description: 'Run the repository test suite' },
  { name: 'grep', description: 'Search file contents by pattern' },
  { name: 'git_diff', description: 'Show the working-tree diff' },
  { name: 'query_metrics', description: 'Query monitoring metrics' },
]

const SELECTION_ANSWERS = {
  rel_files: { noul: 0.96 },
  rel_tests: { noul: 0.05 },
  rel_search: { noul: 0.05 },
  rel_git: { noul: 0.05 },
  rel_monitoring: { noul: 0.05 },
  pick_files: { choice: { choice: 'read_file', confidence: 0.92 } },
}

const ALLOW_ASSESSMENT = {
  matches_task: { noul: 0.95 },
  missing_information: { noul: 0.05 },
  violates_restriction: { noul: 0.04 },
}

const HOLD_ASSESSMENT = {
  matches_task: { noul: 0.9 },
  missing_information: { noul: 0.95 },
  violates_restriction: { noul: 0.05 },
}

function pluginConfig(mode: 'shadow' | 'enforce', assessment: Record<string, unknown>, live: boolean): JevPluginConfig {
  return {
    ...(live
      ? { provider: 'live', apiKey: process.env.TYPESAFE_API_KEY, mode: 'shadow' }
      : { provider: 'mock', mode }),
    selection: {
      enabled: true,
      toolCategories: {
        read_file: ['files'],
        write_file: ['files'],
        run_tests: ['tests'],
        grep: ['search'],
        git_diff: ['git'],
        query_metrics: ['monitoring'],
      },
    },
    assessment: { enabled: true, onFailure: 'ask' },
    loopDetection: { enabled: true, maxRepeats: 2 },
    ...(live ? {} : { mock: { answers: { ...SELECTION_ANSWERS, ...assessment } } }),
  }
}

async function runVariant(
  label: string,
  repetitions: number,
  setup: (ctx: Context) => Promise<void>,
): Promise<VariantMetrics[]> {
  const results: VariantMetrics[] = []
  for (let index = 0; index < repetitions; index += 1) {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await setup(ctx)

    const adapter = new MeasuringAdapter()
    ctx.llm.registerAdapter(['scripted'], adapter)
    const harness = await mountAgentLoopTestHarness(ctx)
    const executions: string[] = []
    for (const tool of TOOLS) {
      ctx.tools.register({
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: [],
          additionalProperties: false,
        },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
        async execute() {
          executions.push(tool.name)
          return 'ok'
        },
      })
    }

    const agent = await harness.create(SessionId(`bench-${label}-${index}`), { provider: 'scripted', model: 'scripted-1' })
    adapter.enqueue(`bench-${label}-${index}`, CALL, FINISH)
    // Snapshot the counters by value: the live object keeps mutating.
    const before = { ...(ctx.jev?.stats ?? {}) } as Record<string, number>
    const started = performance.now()
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Read /sandbox/notes.txt and then report what you did. Change nothing else.' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    const wallMs = performance.now() - started
    const stats = (ctx.jev?.stats ?? {}) as Record<string, number>
    const delta = (key: string): number => (stats[key] ?? 0) - (before[key] ?? 0)
    results.push({
      wallMs,
      toolsBytes: adapter.toolsBytes,
      messagesBytes: adapter.messagesBytes,
      modelRequests: adapter.requestCount,
      toolExecutions: executions.length,
      selections: delta('selections'),
      assessments: delta('assessments'),
      asks: delta('asks'),
      holds: delta('holds'),
      denials: delta('denials'),
      restrictionsApplied: delta('restrictionsApplied'),
    })
    await ctx.fiber.dispose()
  }
  return results
}

function summarize(values: readonly number[]): { mean: number; p50: number; min: number; max: number } {
  const sorted = [...values].sort((a, b) => a - b)
  const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
  return {
    mean,
    p50: sorted[Math.floor(sorted.length / 2)] ?? 0,
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
  }
}

function report(label: string, runs: readonly VariantMetrics[]): void {
  const wall = summarize(runs.map(run => run.wallMs))
  const first = runs[0]
  console.log(
    `${label.padEnd(26)} wall(ms) mean=${wall.mean.toFixed(0)} p50=${wall.p50.toFixed(0)} min=${wall.min.toFixed(0)} max=${wall.max.toFixed(0)}`
    + ` | tools=${(first?.toolsBytes ?? 0).toLocaleString()} B`
    + ` | modelReq=${first?.modelRequests ?? 0}`
    + ` | toolRuns=${first?.toolExecutions ?? 0}`
    + ` | select=${first?.selections ?? 0} assess=${first?.assessments ?? 0}`
    + ` | ask=${first?.asks ?? 0} hold=${first?.holds ?? 0} deny=${first?.denials ?? 0} restrict=${first?.restrictionsApplied ?? 0}`,
  )
}

async function main(): Promise<void> {
  console.log(`=== deterministic harness comparison (scripted model, ${REPETITIONS} runs/variant) ===`)
  const baseline = await runVariant('base', REPETITIONS, async () => {})
  report('A base (no jev)', baseline)

  const shadow = await runVariant('shadow', REPETITIONS, async (ctx) => {
    await ctx.plugin(JevPlugin, pluginConfig('shadow', ALLOW_ASSESSMENT, false))
  })
  report('B jev mock shadow', shadow)

  const enforce = await runVariant('enforce', REPETITIONS, async (ctx) => {
    await ctx.plugin(JevPlugin, pluginConfig('enforce', ALLOW_ASSESSMENT, false))
  })
  report('C jev mock enforce', enforce)

  const gated = await runVariant('gated', REPETITIONS, async (ctx) => {
    await ctx.plugin(JevPlugin, pluginConfig('enforce', HOLD_ASSESSMENT, false))
  })
  report('C2 mock enforce + hold', gated)

  const key = process.env.TYPESAFE_API_KEY
  let live: VariantMetrics[] | undefined
  if (key !== undefined && key.trim().length > 0) {
    live = await runVariant('live', LIVE_REPETITIONS, async (ctx) => {
      await ctx.plugin(JevPlugin, pluginConfig('shadow', ALLOW_ASSESSMENT, true))
    })
    report(`D jev live shadow (${LIVE_REPETITIONS})`, live)
  } else {
    console.log('D jev live shadow            NOT EXECUTED (TYPESAFE_API_KEY not set)')
  }

  const deltaEnforce = summarize(enforce.map(run => run.wallMs)).mean - summarize(baseline.map(run => run.wallMs)).mean
  console.log('\nreading:')
  console.log(`- enforce turn delta vs base: ${deltaEnforce >= 0 ? '+' : ''}${deltaEnforce.toFixed(0)} ms (mock Jev ≈ 0; the rest is enforcement bookkeeping)`)
  console.log(`- tool schemas sent: base ${(baseline[0]?.toolsBytes ?? 0).toLocaleString()} B vs enforce ${(enforce[0]?.toolsBytes ?? 0).toLocaleString()} B (selection narrowed the visible set)`)
  console.log(`- with a hold assessment, tool executions: base ${baseline[0]?.toolExecutions ?? 0} vs gated ${gated[0]?.toolExecutions ?? 0}`)

  const outDir = fileURLToPath(new URL('./results/', import.meta.url))
  mkdirSync(outDir, { recursive: true })
  const artifact = {
    kind: 'deterministic-harness-comparison',
    when: new Date().toISOString(),
    repetitions: REPETITIONS,
    liveRepetitions: LIVE_REPETITIONS,
    variants: { baseline, shadow, enforce, gated, ...(live === undefined ? {} : { live }) },
  }
  const file = `${outDir}deterministic-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  writeFileSync(file, JSON.stringify(artifact, null, 2))
  console.log(`\nartifact: ${file}`)
  console.log('limits: scripted model, one machine, no real-model prompt-size effect; see docs/benchmark.md')
}

await main()
