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
 *   BENCH_BASE_URL     OpenAI-compatible base URL
 *                      (OpenCode Go: https://opencode.ai/zen/go/v1)
 *   BENCH_MODEL        model id served by that gateway (e.g. deepseek-v4.1-flash)
 *   BENCH_API_KEY      the key (passed to the child only, never written)
 *   BENCH_API_KEY_ENV  variable name the profile resolves (default BENCH_API_KEY)
 * Optional:
 *   BENCH_SESSION_HEADER  header carrying a fresh per-run session id
 *                         (OpenCode Go requires `x-opencode-session`)
 *   BENCH_USER_AGENT      client identification (default dsh-bench/0.1)
 *   DSH_BIN            path to the dsh binary (default: dsh from PATH)
 *   BENCH_HOME         DSH_HOME for the bench (default: a fresh temp dir)
 *   BENCH_RUNS         runs per variant (default 5)
 *   BENCH_TASK         task text (default: read notes.txt in the sandbox cwd)
 *   TYPESAFE_API_KEY   enables the third variant (Jev live instead of mock)
 *
 * Usage (OpenCode Go):
 *   BENCH_BASE_URL=https://opencode.ai/zen/go/v1 BENCH_MODEL=deepseek-v4.1-flash \
 *   BENCH_API_KEY=… BENCH_SESSION_HEADER=x-opencode-session BENCH_RUNS=5 \
 *   TYPESAFE_API_KEY=… node scripts/bench-cli.mjs
 *
 * Not part of `pnpm verify`: it needs an external gateway and produces
 * measurements, not assertions. See docs/benchmark.md.
 */

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const resultsDir = join(root, 'bench', 'results')
const sandbox = join(root, 'bench', 'sandbox')
const baseUrl = process.env.BENCH_BASE_URL
const model = process.env.BENCH_MODEL
const apiKey = process.env.BENCH_API_KEY
const apiKeyEnv = process.env.BENCH_API_KEY_ENV ?? 'BENCH_API_KEY'
const sessionHeader = process.env.BENCH_SESSION_HEADER
const userAgent = process.env.BENCH_USER_AGENT ?? 'dsh-bench/0.1 (buberlo/dsh-jev)'
const dshBin = process.env.DSH_BIN ?? 'dsh'
const runs = Number.parseInt(process.env.BENCH_RUNS ?? '5', 10)
const task = process.env.BENCH_TASK
  ?? 'Read the file notes.txt in the current directory and then report in one sentence what it says. Change nothing else.'
const typesafeKey = process.env.TYPESAFE_API_KEY

if (baseUrl === undefined || model === undefined || apiKey === undefined) {
  console.log('CLI comparison NOT EXECUTED: set BENCH_BASE_URL, BENCH_MODEL and BENCH_API_KEY.')
  console.log('OpenCode Go example:')
  console.log('  BENCH_BASE_URL=https://opencode.ai/zen/go/v1 BENCH_MODEL=deepseek-v4.1-flash \\')
  console.log('  BENCH_API_KEY=… BENCH_SESSION_HEADER=x-opencode-session node scripts/bench-cli.mjs')
  console.log('See docs/benchmark.md for the recorded state and limits.')
  process.exit(0)
}

mkdirSync(sandbox, { recursive: true })
writeFileSync(join(sandbox, 'notes.txt'), 'Bench sandbox note: the tool pipeline is being measured.\n')

const home = process.env.BENCH_HOME ?? mkdtempSync(join(tmpdir(), 'dsh-bench-'))
const env = { ...process.env, DSH_HOME: home, [apiKeyEnv]: apiKey }

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env,
    cwd: options.cwd ?? sandbox,
    timeout: options.timeout ?? 300_000,
    ...options,
  })
  if (result.error !== undefined) throw result.error
  return result
}

const dsh = (args, options) => run(dshBin, args, options)

/**
 * BENCH_LOCAL_PACKS=<dir>: overlay freshly packed tarballs on the profile so
 * the benchmark measures the working tree, not the published registry version.
 * Registry installs stay the normal path; this is a development override.
 */
function overlayLocalPacks(profileDir) {
  const packsDir = process.env.BENCH_LOCAL_PACKS
  if (packsDir === undefined) return
  for (const [pkg, prefix] of [['jev-core', 'buberlo-jev-core-'], ['dsh-jev', 'buberlo-dsh-jev-']]) {
    const tarball = readdirSync(packsDir).find(name => name.startsWith(prefix) && name.endsWith('.tgz'))
    if (tarball === undefined) throw new Error(`BENCH_LOCAL_PACKS: no ${prefix}*.tgz in ${packsDir}`)
    const target = join(profileDir, 'node_modules', '@buberlo', pkg)
    rmSync(target, { recursive: true, force: true })
    mkdirSync(target, { recursive: true })
    const extracted = spawnSync('tar', ['-xzf', join(packsDir, tarball), '-C', target, '--strip-components=1'], { encoding: 'utf8' })
    if (extracted.status !== 0) throw new Error(`overlay failed for ${pkg}: ${extracted.stderr}`)
  }
  console.log(`overlay: local packs from ${packsDir} installed over the profile`)
}


function writePatch(name, body) {
  const path = join(root, 'bench', name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
  return path
}

/**
 * One route row for the gateway and one default-model override, identical for
 * every variant. `sessionId` (when given) becomes the per-run session header
 * the gateway uses for routing and prompt caching.
 */
function llmPatchBody(sessionId) {
  const headers = [
    `          user-agent: ${JSON.stringify(userAgent)}`,
    ...(sessionHeader === undefined ? [] : [`          ${sessionHeader}: ${JSON.stringify(sessionId ?? 'dsh-bench')}`]),
  ]
  return [
    '- id: agent-default-model',
    '  name: \'@deepseek-ai/dsh-agent-default-model\'',
    '  config:',
    '    provider: bench-gateway',
    `    model: ${model}`,
    // The policy layer already mounts dsh-llm-pi-ai: override that row and
    // declare our gateway route instead of inserting a second adapter row.
    '- id: llm-pi-ai',
    '  name: \'@deepseek-ai/dsh-llm-pi-ai\'',
    '  config:',
    '    providers:',
    '      bench-gateway:',
    '        api: openai-completions',
    `        baseURL: ${baseUrl}`,
    `        apiKeyEnv: ${apiKeyEnv}`,
    '        headers:',
    ...headers,
    '        models:',
    `          - id: ${model}`,
    `            name: ${model}`,
    '',
  ].join('\n')
}

const staticLlmPatch = writePatch('llm.patch.yml', llmPatchBody(undefined))

// Enforce variant: the plugin narrows the visible tools to `read` (the tool the
// task needs) and allows the call. Mock answers are synthetic; the point is
// the real model's token/latency response to the smaller tool surface.
const enforcePatch = writePatch('jev-enforce.patch.yml', [
  '- id: jev',
  '  name: \'@buberlo/dsh-jev\'',
  '  config:',
  '    provider: mock',
  '    mode: enforce',
  '    thresholds: { relevance: 0.9 }',
  '    selection:',
  '      enabled: true',
  '      toolCategories:',
  '        read: [files]',
  '        write: [files]',
  '        edit: [files]',
  '    assessment: { enabled: true, onFailure: ask }',
  '    mock:',
  '      answers:',
  '        rel_files: { noul: 0.96 }',
  '        pick_files: { choice: { choice: read, confidence: 0.92 } }',
  '        matches_task: { noul: 0.95 }',
  '        missing_information: { noul: 0.05 }',
  '        violates_restriction: { noul: 0.04 }',
  '',
].join('\n'))

const livePatch = typesafeKey === undefined ? undefined : writePatch('jev-live.patch.yml', [
  '- id: jev',
  '  name: \'@buberlo/dsh-jev\'',
  '  config:',
  '    provider: live',
  '    mode: shadow',
  '    apiKey: !!js process.env.TYPESAFE_API_KEY',
  '',
].join('\n'))

// Profiles from the same template.
for (const profile of ['bench-base', 'bench-jev']) {
  // Create from the shipped headless template once; reuse on later runs.
  const exists = existsSync(join(home, 'profiles', profile, 'package.json'))
  const args = exists
    ? ['--profile', profile, '--dump-config']
    : ['--profile', profile, '--from-default-profile', 'headless', '--dump-config']
  const composed = dsh(args, { stdio: 'ignore' })
  if (composed.status !== 0) throw new Error(`profile ${profile} did not compose`)
}
const add = dsh(['plugin', '--profile', 'bench-jev', 'add', '@buberlo/dsh-jev'])
if (add.status !== 0) {
  console.error(add.stdout, add.stderr)
  throw new Error('dsh plugin add @buberlo/dsh-jev failed')
}
overlayLocalPacks(join(home, 'profiles', 'bench-jev'))

function runVariant(label, profile, extraPatches) {
  const measurements = []
  for (let index = 0; index < runs; index += 1) {
    // A fresh session id per run: one conversation, one gateway routing key.
    const llmPatch = sessionHeader === undefined
      ? staticLlmPatch
      : writePatch(`llm-run-${index}.patch.yml`, llmPatchBody(randomUUID()))
    const patches = [llmPatch, ...extraPatches]
    const started = performance.now()
    const result = dsh([
      '--profile', profile,
      ...patches.flatMap(patch => ['--patch', patch]),
      '--json', task,
    ], { timeout: 600_000 })
    const wallMs = performance.now() - started
    const stderr = result.stderr ?? ''
    const stdout = result.stdout ?? ''
    const jevLines = stderr.split('\n').filter(line => line.includes('[dsh-jev]'))
    mkdirSync(join(resultsDir, label), { recursive: true })
    writeFileSync(join(resultsDir, label, `run-${index}.stderr.log`), stderr)
    writeFileSync(join(resultsDir, label, `run-${index}.jsonl`), stdout)
    const tokenSum = (field) => [...stdout.matchAll(new RegExp(`"${field}":\\s*(\\d+)`, 'g'))]
      .reduce((sum, match) => sum + Number(match[1]), 0)
    measurements.push({
      wallMs,
      exit: result.status,
      jevDecisions: jevLines.length,
      toolCalls: [...stdout.matchAll(/"type":"tool_call"/g)].length,
      inputTokens: tokenSum('inputTokens'),
      outputTokens: tokenSum('outputTokens'),
      cacheReadTokens: tokenSum('cacheReadTokens'),
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
  ['base', 'bench-base', []],
  ['jev-mock', 'bench-jev', []],
  ['jev-enforce', 'bench-jev', [enforcePatch]],
  ...(livePatch === undefined ? [] : [['jev-live', 'bench-jev', [livePatch]]]),
]

console.log(`=== CLI comparison (${runs} runs/variant, model ${model}) ===`)
console.log(`home: ${home}`)
console.log(`session header: ${sessionHeader ?? '(none)'} | user agent: ${userAgent}`)
const report = []
for (const [label, profile, extraPatches] of variants) {
  const measurements = runVariant(label, profile, extraPatches)
  const wall = summarize(measurements.map(measurement => measurement.wallMs))
  const ok = measurements.filter(measurement => measurement.exit === 0).length
  const ine = measurements.reduce((sum, measurement) => sum + measurement.inputTokens, 0)
  const out = measurements.reduce((sum, measurement) => sum + measurement.outputTokens, 0)
  const decisions = measurements.reduce((sum, measurement) => sum + measurement.jevDecisions, 0)
  const outc = measurements.reduce((sum, measurement) => sum + measurement.outputTokens, 0)
  const cache = measurements.reduce((sum, measurement) => sum + measurement.cacheReadTokens, 0)
  const tools = measurements.reduce((sum, measurement) => sum + measurement.toolCalls, 0)
  console.log(
    `${label.padEnd(10)} ok=${ok}/${measurements.length} wall mean=${wall.mean.toFixed(0)}ms p50=${wall.p50.toFixed(0)}ms `
    + `min=${wall.min.toFixed(0)}ms max=${wall.max.toFixed(0)}ms | tokens in=${ine} out=${outc} cached=${cache}`
    + ` | tool calls=${tools} | jev log lines=${decisions}`,
  )
  report.push({ label, profile, wall, ok, inputTokens: ine, outputTokens: outc, cacheReadTokens: cache, toolCalls: tools, jevDecisions: decisions, measurements })
}

mkdirSync(resultsDir, { recursive: true })
const artifact = `${resultsDir}/cli-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
writeFileSync(artifact, JSON.stringify({
  kind: 'cli-comparison',
  when: new Date().toISOString(),
  model,
  baseUrl,
  sessionHeader: sessionHeader ?? null,
  userAgent,
  task,
  runs,
  variants: report,
}, null, 2))
console.log(`\nartifact: ${artifact}`)
console.log('reading: wall-clock includes the real model; compare like-for-like runs and report ranges,')
console.log('never a single number. Failed runs carry the provider error in the artifacts.')
