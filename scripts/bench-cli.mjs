#!/usr/bin/env node
/**
 * CLI comparison: the real `dsh` product, two profiles that differ only by the
 * Jev bundle, the same task, N runs each, full run recordings as artifacts.
 *
 * The model route is a hand-declared OpenAI-compatible gateway through
 * `@deepseek-ai/dsh-llm-pi-ai`; no secret enters any file (only `apiKeyEnv`
 * references an environment variable of the launching process).
 *
 * Required environment:
 *   BENCH_BASE_URL     OpenAI-compatible base URL, e.g. https://gateway.example/v1
 *   BENCH_MODEL        model id served by that gateway
 *   BENCH_API_KEY      the key (passed to the child only, never written)
 *   BENCH_API_KEY_ENV  variable name the profile resolves (default BENCH_API_KEY)
 * Optional:
 *   DSH_BIN            path to the dsh binary (default: dsh from PATH)
 *   BENCH_HOME         DSH_HOME for the bench (default: a fresh temp dir)
 *   BENCH_RUNS         runs per variant (default 5)
 *   BENCH_TASK         task text (default: the sandbox read task)
 *   TYPESAFE_API_KEY   enables the third variant (Jev live instead of mock)
 *
 * Usage:
 *   BENCH_BASE_URL=... BENCH_MODEL=... BENCH_API_KEY=... node scripts/bench-cli.mjs
 *
 * Not part of `pnpm verify`: it needs an external gateway and produces
 * measurements, not assertions. See docs/benchmark.md for the recorded state.
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const resultsDir = join(root, 'bench', 'results')
const baseUrl = process.env.BENCH_BASE_URL
const model = process.env.BENCH_MODEL
const apiKey = process.env.BENCH_API_KEY
const apiKeyEnv = process.env.BENCH_API_KEY_ENV ?? 'BENCH_API_KEY'
const dshBin = process.env.DSH_BIN ?? 'dsh'
const runs = Number.parseInt(process.env.BENCH_RUNS ?? '5', 10)
const task = process.env.BENCH_TASK
  ?? 'Read the file /sandbox/notes.txt and then report in one sentence what you did. Change nothing else.'
const typesafeKey = process.env.TYPESAFE_API_KEY

if (baseUrl === undefined || model === undefined || apiKey === undefined) {
  console.log('CLI comparison NOT EXECUTED: set BENCH_BASE_URL, BENCH_MODEL and BENCH_API_KEY.')
  console.log('The published opencode-go key cannot be used here: its free tier answers')
  console.log('403 "can only be used from within OpenCode" and paid models answer')
  console.log('402 "Insufficient account funds" for external callers (measured 2026-09-19).')
  console.log('Any OpenAI-compatible gateway works; see docs/benchmark.md.')
  process.exit(0)
}

const home = process.env.BENCH_HOME ?? mkdtempSync(join(tmpdir(), 'dsh-bench-'))
const env = { ...process.env, DSH_HOME: home, [apiKeyEnv]: apiKey }

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env,
    timeout: options.timeout ?? 300_000,
    ...options,
  })
  if (result.error !== undefined) throw result.error
  return result
}

function dsh(args, options) {
  return run(dshBin, args, options)
}

function writePatch(name, body) {
  const path = join(root, 'bench', name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
  return path
}

// 1. One route row for the gateway and one default-model override. Both
//    variants get exactly the same LLM patch.
const llmPatch = writePatch('llm.patch.yml', [
  '- id: agent-default-model',
  '  name: \'@deepseek-ai/dsh-agent-default-model\'',
  '  config:',
  '    provider: bench-gateway',
  `    model: ${model}`,
  // The policy layer already mounts dsh-llm-pi-ai: override that row and
  // declare our gateway route instead of inserting a second adapter row
  // (a second row would collide on the catalog providers it declares).
  '- id: llm-pi-ai',
  '  name: \'@deepseek-ai/dsh-llm-pi-ai\'',
  '  config:',
  '    providers:',
  '      bench-gateway:',
  '        api: openai-completions',
  `        baseURL: ${baseUrl}`,
  `        apiKeyEnv: ${apiKeyEnv}`,
  '        models:',
  `          - id: ${model}`,
  `            name: ${model}`,
  '',
].join('\n'))

// 2. Live-Jev overlay: only this row differs from the mock variant.
const livePatch = typesafeKey === undefined ? undefined : writePatch('jev-live.patch.yml', [
  '- id: jev',
  '  name: \'@buberlo/dsh-jev\'',
  '  config:',
  '    provider: live',
  '    mode: shadow',
  '    apiKey: !!js process.env.TYPESAFE_API_KEY',
  '',
].join('\n'))

// 3. Profiles from the same template.
for (const profile of ['bench-base', 'bench-jev']) {
  const composed = dsh(['--profile', profile, '--from-default-profile', 'headless', '--dump-config'], { stdio: 'ignore' })
  if (composed.status !== 0) throw new Error(`profile ${profile} did not compose`)
}
const add = dsh(['plugin', '--profile', 'bench-jev', 'add', '@buberlo/dsh-jev'])
if (add.status !== 0) {
  console.error(add.stdout, add.stderr)
  throw new Error('dsh plugin add @buberlo/dsh-jev failed')
}

function runVariant(label, profile, patches) {
  const measurements = []
  for (let index = 0; index < runs; index += 1) {
    const patchArgs = patches.flatMap(patch => ['--patch', patch])
    const started = performance.now()
    const result = dsh(['--profile', profile, ...patchArgs, '--json', task], { timeout: 600_000 })
    const wallMs = performance.now() - started
    const stderr = result.stderr ?? ''
    const stdout = result.stdout ?? ''
    const jevLines = stderr.split('\n').filter(line => line.includes('[dsh-jev]'))
    mkdirSync(join(resultsDir, label), { recursive: true })
    writeFileSync(join(resultsDir, label, `run-${index}.stderr.log`), stderr)
    writeFileSync(join(resultsDir, label, `run-${index}.jsonl`), stdout)
    measurements.push({
      wallMs,
      exit: result.status,
      jevDecisions: jevLines.length,
      inputTokens: [...stdout.matchAll(/"input_tokens":\s*(\d+)/g)].reduce((sum, match) => sum + Number(match[1]), 0),
      outputTokens: [...stdout.matchAll(/"output_tokens":\s*(\d+)/g)].reduce((sum, match) => sum + Number(match[1]), 0),
    })
  }
  return measurements
}

const summarize = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    mean: values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length),
    p50: sorted[Math.floor(sorted.length / 2)] ?? 0,
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
  }
}

const variants = [
  ['base', 'bench-base', [llmPatch]],
  ['jev-mock', 'bench-jev', [llmPatch]],
  ...(livePatch === undefined ? [] : [['jev-live', 'bench-jev', [llmPatch, livePatch]]]),
]

console.log(`=== CLI comparison (${runs} runs/variant, model ${model}) ===`)
console.log(`home: ${home}`)
const report = []
for (const [label, profile, patches] of variants) {
  const measurements = runVariant(label, profile, patches)
  const wall = summarize(measurements.map(measurement => measurement.wallMs))
  const ok = measurements.filter(measurement => measurement.exit === 0).length
  const ine = measurements.reduce((sum, measurement) => sum + measurement.inputTokens, 0)
  const out = measurements.reduce((sum, measurement) => sum + measurement.outputTokens, 0)
  const decisions = measurements.reduce((sum, measurement) => sum + measurement.jevDecisions, 0)
  console.log(
    `${label.padEnd(10)} ok=${ok}/${measurements.length} wall mean=${wall.mean.toFixed(0)}ms p50=${wall.p50.toFixed(0)}ms `
    + `min=${wall.min.toFixed(0)}ms max=${wall.max.toFixed(0)}ms | tokens in=${ine} out=${out} | jev log lines=${decisions}`,
  )
  report.push({ label, profile, wall, ok, inputTokens: ine, outputTokens: out, jevDecisions: decisions, measurements })
}

mkdirSync(resultsDir, { recursive: true })
const artifact = `${resultsDir}/cli-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
writeFileSync(artifact, JSON.stringify({
  kind: 'cli-comparison',
  when: new Date().toISOString(),
  model,
  baseUrl,
  task,
  runs,
  variants: report,
}, null, 2))
console.log(`\nartifact: ${artifact}`)
console.log('reading: wall-clock includes the real model; compare like-for-like runs and report ranges,')
console.log('never a single number. If the gateway key is unusable, runs fail with the provider error in the artifacts.')
