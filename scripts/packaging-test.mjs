/**
 * Packaging test: pack both packages, install the tarballs into a temporary
 * consumer project together with the pinned DSH peers from npm, then verify
 * imports, TypeScript types, real plugin loading, and that no second Cordis
 * runtime is bundled.
 *
 * Run: pnpm test:packaging
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'dsh-jev-packaging-'))
const packs = join(work, 'packs')
const consumer = join(work, 'consumer')
const keep = process.argv.includes('--keep')

const DSH_VERSION = '0.1.6-alpha.2'
const CORDIS_VERSION = '4.0.2'
const TYPESCRIPT_VERSION = '6.0.3'

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    ...options,
  })
}

function step(message) {
  console.log(`\n[packaging] ${message}`)
}

try {
  run('mkdir', ['-p', packs, consumer])

  step('packing @buberlo/jev-core and @buberlo/dsh-jev')
  for (const pkg of ['packages/jev-core', 'packages/dsh-jev']) {
    run('pnpm', ['pack', '--pack-destination', packs], { cwd: join(root, pkg) })
  }
  const tarballs = readdirSync(packs).filter(name => name.endsWith('.tgz'))
  const coreTar = tarballs.find(name => name.includes('jev-core'))
  const dshTar = tarballs.find(name => name.includes('dsh-jev'))
  if (coreTar === undefined || dshTar === undefined) {
    throw new Error(`expected two tarballs, found: ${tarballs.join(', ')}`)
  }
  console.log(`  ${coreTar}\n  ${dshTar}`)

  step('creating the consumer project')
  const dependencies = {
    '@buberlo/jev-core': `file:${join(packs, coreTar)}`,
    '@buberlo/dsh-jev': `file:${join(packs, dshTar)}`,
    '@deepseek-ai/cordis': CORDIS_VERSION,
    '@deepseek-ai/dsh-agent': DSH_VERSION,
    '@deepseek-ai/dsh-llm': DSH_VERSION,
    '@deepseek-ai/dsh-scope': DSH_VERSION,
    '@deepseek-ai/dsh-session': DSH_VERSION,
    '@deepseek-ai/dsh-skill': DSH_VERSION,
    '@deepseek-ai/dsh-system-prompt': DSH_VERSION,
    '@deepseek-ai/dsh-tools': DSH_VERSION,
    'typescript': TYPESCRIPT_VERSION,
  }
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({
    name: 'dsh-jev-packaging-consumer',
    private: true,
    type: 'module',
    dependencies,
  }, null, 2))

  step('installing tarballs + pinned DSH peers (npm, no registry dependency on @buberlo/*)')
  run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: consumer })

  step('checking the packed manifests')
  const packedManifest = JSON.parse(run('tar', ['-xOf', join(packs, dshTar), 'package/package.json']))
  if (packedManifest.dsh?.bundle?.patch !== './cordis.patch.yml') {
    throw new Error('packed @buberlo/dsh-jev is missing the dsh.bundle.patch manifest entry')
  }
  const packedFiles = run('tar', ['-tf', join(packs, dshTar)])
  for (const required of ['package/lib/index.js', 'package/lib/types/index.d.ts', 'package/cordis.patch.yml']) {
    if (!packedFiles.includes(required)) throw new Error(`packed dsh-jev is missing ${required}`)
  }
  if (packedManifest.dependencies['@buberlo/jev-core'].includes('workspace:')) {
    throw new Error('packed manifest still contains the workspace: protocol')
  }

  step('running the runtime smoke (real DSH services + installed plugin)')
  writeFileSync(join(consumer, 'smoke.mjs'), `
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import JevPlugin from '@buberlo/dsh-jev'
import { createJevCore, MockJevProvider } from '@buberlo/jev-core'

// 1. jev-core works standalone.
const core = createJevCore({ provider: new MockJevProvider(), mode: 'shadow' })
const result = await core.evaluate({
  state: 'x',
  questions: { q: { type: 'noul', instructions: 'Is this working?' } },
})
assert.equal(result.ok, true)

// 2. The plugin loads with the real tool registry and enforces its assessment.
const executed = []
const ctx = new Context()
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
await ctx.plugin(JevPlugin, {
  provider: 'mock',
  mode: 'enforce',
  selection: { enabled: false },
  assessment: { enabled: true, onFailure: 'ask' },
  mock: { answers: {
    matches_task: { noul: 0.9 },
    missing_information: { noul: 0.95 },
    violates_restriction: { noul: 0.05 },
  } },
})
ctx.tools.register({
  name: 'read_file',
  description: 'Read a file.',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
  async execute() { executed.push('ran'); return 'ok' },
})
const scope = createScope(ctx, {})
const agent = { ctx: scope.ctx, session: {} }
ctx.jev.ensureState(agent).updateSnapshot({ task: 'task', step: '', turn: 1 })
const toolResult = await ctx.tools.execute({
  callId: ToolCallId('smoke-1'),
  name: 'read_file',
  arguments: { path: '/tmp/x' },
  agent,
  signal: new AbortController().signal,
})
assert.equal(toolResult.isError, true, 'the gated call must fail closed without an approval answerer')
assert.deepEqual(executed, [])
assert.equal(ctx.jev.stats.asks, 1)

// 3. No second Cordis runtime: the plugin resolves the consumer's host instance.
const require = createRequire(import.meta.url)
const fromPlugin = require.resolve('@deepseek-ai/cordis', { paths: [require.resolve('@buberlo/dsh-jev')] })
const fromConsumer = require.resolve('@deepseek-ai/cordis')
assert.equal(fromPlugin, fromConsumer, 'the plugin must use the host Cordis instance')

await ctx.fiber.dispose()
console.log('smoke: OK (standalone core, real plugin load, fail-closed enforcement, single cordis)')
`)
  console.log(run('node', ['smoke.mjs'], { cwd: consumer }).trim())

  step('type-checking a consumer that uses the published types')
  writeFileSync(join(consumer, 'consumer-types.ts'), `
import { createJevCore, type ToolSelectionPlan, MockJevProvider } from '@buberlo/jev-core'
import JevPlugin, { type JevPluginConfig } from '@buberlo/dsh-jev'

const config: JevPluginConfig = { provider: 'mock', mode: 'shadow' }
const core = createJevCore({ provider: new MockJevProvider(), mode: 'shadow' })
export async function plan(): Promise<ToolSelectionPlan> {
  return core.selectTools({ task: 't', candidates: [{ id: 'a', categories: ['c'], description: 'd' }] })
}
export const plugin = JevPlugin
export const used = config
`)
  writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      target: 'ES2023',
      lib: ['ES2023', 'DOM'],
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
    },
    include: ['consumer-types.ts'],
  }, null, 2))
  const tsc = join(consumer, 'node_modules', '.bin', 'tsc')
  console.log(run(tsc, ['--noEmit'], { cwd: consumer }).trim() || 'tsc: no output (clean)')

  step('packaging test PASSED')
  console.log(`  consumer: ${consumer}`)
} catch (error) {
  console.error('\n[packaging] FAILED')
  if (error.stdout) console.error(String(error.stdout))
  if (error.stderr) console.error(String(error.stderr))
  console.error(error.message)
  process.exitCode = 1
  if (!keep && !existsSync(join(work, 'keep'))) {
    // Keep the directory on failure for inspection.
  }
} finally {
  if (!keep && process.exitCode !== 1) rmSync(work, { recursive: true, force: true })
}
