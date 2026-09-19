/**
 * Evaluations runner.
 *
 * Two strictly separated modes:
 * - default (mock): proves the program logic against fixed synthetic answers.
 *   This is the offline check that runs in `pnpm verify`.
 * - `--live`: measures how Jev actually answers the same fixtures with the
 *   live TypeSafe API. It requires an explicitly passed key and only reports
 *   hits, abstentions, misdecisions, errors, latency, and case count; it makes
 *   no accuracy or cost claims.
 *
 * Usage:
 *   pnpm evals
 *   TYPESAFE_API_KEY=... pnpm evals -- --live
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  createJevCore,
  LiveTypeSafeProvider,
  MockJevProvider,
  type JevCore,
  type MockAnswerSpec,
  type MockScenario,
  type SkillCandidateInfo,
} from '@buberlo/jev-core'

interface FixtureCandidate {
  id: string
  categories: string[]
  description?: string
  restricted?: boolean
}

interface SelectionFixture {
  id: string
  lang: 'en' | 'de'
  kind: 'selection'
  task: string
  step?: string
  candidates: FixtureCandidate[]
  categories: Array<{ id: string; description?: string }>
  answers: Record<string, MockAnswerSpec>
  expect: { status: string; selected: string[]; restrictedNeverSent?: string[] }
}

interface AssessmentFixture {
  id: string
  lang: 'en' | 'de'
  kind: 'assessment'
  task: string
  toolId: string
  arguments: unknown
  restrictions: string[]
  answers: Record<string, MockAnswerSpec>
  expect: { status: string }
}

interface SkillFixture {
  id: string
  lang: 'en' | 'de'
  kind: 'skill'
  task: string
  step?: string
  candidates: SkillCandidateInfo[]
  answers: Record<string, MockAnswerSpec>
  expect: { status: string; skill?: string }
}

type Fixture = SelectionFixture | AssessmentFixture | SkillFixture

function loadFixtures(): Fixture[] {
  const path = fileURLToPath(new URL('../evals/fixtures/decisions.v1.jsonl', import.meta.url))
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as Fixture)
}

function mockScenarioFor(fixture: Fixture): MockScenario {
  return {
    answers: fixture.answers,
    model: 'mock/jev-eval',
    usage: { input_tokens: 0, output_tokens: 0 },
  }
}

interface CaseResult {
  id: string
  kind: string
  lang: string
  expected: string
  actual: string
  pass: boolean
  detail?: string
  /** Actual model id reported by the provider for this case. */
  model?: string
  latencyMs: number
}

async function runMock(fixture: Fixture): Promise<CaseResult> {
  const core = createJevCore({
    provider: new MockJevProvider({ scenario: mockScenarioFor(fixture) }),
    mode: 'enforce',
  })
  return evaluateCase(core, fixture)
}

async function evaluateCase(core: JevCore, fixture: Fixture): Promise<CaseResult> {
  const started = performance.now()
  if (fixture.kind === 'selection') {
    const plan = await core.selectTools({
      task: fixture.task,
      ...(fixture.step === undefined ? {} : { step: fixture.step }),
      candidates: fixture.candidates.map(candidate => ({
        id: candidate.id,
        categories: candidate.categories,
        ...(candidate.description === undefined ? {} : { description: candidate.description }),
        ...(candidate.restricted === undefined ? {} : { restricted: candidate.restricted }),
      })),
      categories: fixture.categories.map(category => ({
        id: category.id,
        ...(category.description === undefined ? {} : { description: category.description }),
      })),
    })
    const selectedMatches = JSON.stringify([...plan.selected].sort()) === JSON.stringify([...fixture.expect.selected].sort())
    const statusMatches = plan.status === fixture.expect.status
    // Restricted candidates must never leave the process: they must appear in
    // the local skip diagnostics and never in the selection.
    const skipped = new Set(plan.diagnostics.restrictedSkipped)
    const restrictedOk = (fixture.expect.restrictedNeverSent ?? [])
      .every(id => skipped.has(id) && !plan.selected.includes(id))
    return {
      id: fixture.id,
      kind: fixture.kind,
      lang: fixture.lang,
      expected: `${fixture.expect.status} [${fixture.expect.selected.join(', ')}]`,
      actual: `${plan.status} [${plan.selected.join(', ')}]`,
      pass: statusMatches && selectedMatches && restrictedOk,
      detail: plan.failure?.code,
      ...(plan.diagnostics.model === undefined ? {} : { model: plan.diagnostics.model }),
      latencyMs: performance.now() - started,
    }
  }
  if (fixture.kind === 'skill') {
    const result = await core.routeSkills({
      task: fixture.task,
      ...(fixture.step === undefined ? {} : { step: fixture.step }),
      candidates: fixture.candidates,
    })
    const actual = result.skill === undefined ? result.status : `${result.status} [${result.skill}]`
    const expected = fixture.expect.skill === undefined
      ? fixture.expect.status
      : `${fixture.expect.status} [${fixture.expect.skill}]`
    return {
      id: fixture.id,
      kind: fixture.kind,
      lang: fixture.lang,
      expected,
      actual,
      pass: result.status === fixture.expect.status && result.skill === fixture.expect.skill,
      detail: result.failure?.code,
      ...(result.diagnostics.model === undefined ? {} : { model: result.diagnostics.model }),
      latencyMs: performance.now() - started,
    }
  }
  const assessment = await core.assessToolCall({
    task: fixture.task,
    toolId: fixture.toolId,
    arguments: fixture.arguments,
    restrictions: fixture.restrictions,
  })
  return {
    id: fixture.id,
    kind: fixture.kind,
    lang: fixture.lang,
    expected: fixture.expect.status,
    actual: assessment.status,
    pass: assessment.status === fixture.expect.status,
    detail: assessment.failure?.code ?? assessment.decisions[0]?.rule,
    ...(assessment.diagnostics.model === undefined ? {} : { model: assessment.diagnostics.model }),
    latencyMs: performance.now() - started,
  }
}

function report(results: CaseResult[], modeLabel: string): void {
  console.log(`\n=== Jev evaluation (${modeLabel}) ===`)
  console.log(`${'id'.padEnd(12)} ${'kind'.padEnd(11)} ${'lang'.padEnd(4)} ${'expected'.padEnd(34)} ${'actual'.padEnd(34)} result`)
  for (const result of results) {
    console.log(
      `${result.id.padEnd(12)} ${result.kind.padEnd(11)} ${result.lang.padEnd(4)} `
      + `${result.expected.slice(0, 33).padEnd(34)} ${result.actual.slice(0, 33).padEnd(34)} `
      + `${result.pass ? 'PASS' : 'FAIL'}${result.detail === undefined ? '' : ` (${result.detail})`}`,
    )
  }
  const passed = results.filter(result => result.pass).length
  const latencies = results.map(result => result.latencyMs).sort((a, b) => a - b)
  console.log(`\ncases: ${results.length}, pass: ${passed}, fail: ${results.length - passed}`)
  console.log(`latency: mean ${(latencies.reduce((sum, value) => sum + value, 0) / Math.max(1, latencies.length)).toFixed(1)}ms, p50 ${(latencies[Math.floor(latencies.length / 2)] ?? 0).toFixed(1)}ms`)
}

async function main(): Promise<void> {
  const fixtures = loadFixtures()
  const live = process.argv.includes('--live')

  if (!live) {
    const results: CaseResult[] = []
    for (const fixture of fixtures) results.push(await runMock(fixture))
    report(results, 'mock — proves program logic, NOT model quality')
    if (results.some(result => !result.pass)) process.exitCode = 1
    return
  }

  const apiKey = process.env.TYPESAFE_API_KEY
  if (apiKey === undefined || apiKey.trim().length === 0) {
    console.log('live evaluation NOT EXECUTED: TYPESAFE_API_KEY is not set.')
    console.log('This is not a pass; it is an explicit non-run (see docs/evaluation.md).')
    return
  }
  const provider = new LiveTypeSafeProvider({
    apiKey,
    ...(process.env.TYPESAFE_MODEL === undefined ? {} : { model: process.env.TYPESAFE_MODEL }),
    maxRetries: 1,
    timeoutMs: 20000,
  })
  const core = createJevCore({ provider, mode: 'enforce', limits: { budgetMs: 30000 } })
  const results: CaseResult[] = []
  for (const fixture of fixtures) results.push(await evaluateCase(core, fixture))
  const models = [...new Set(results.map(result => result.model).filter((model): model is string => model !== undefined))]
  report(results, `live (models answered: ${models.join(', ') || provider.defaultModel}) — measures Jev behavior, no accuracy claims`)
  const abstentions = results.filter(result => result.actual.startsWith('abstained') || result.actual === 'none').length
  const errors = results.filter(result => result.actual === 'fallback' || result.detail?.includes('INVALID') === true).length
  console.log(`abstentions: ${abstentions}, errors: ${errors}, misdecisions (vs fixture expectation): ${results.filter(result => !result.pass).length}`)
  console.log('Note: the fixture expectations were authored offline; a live mismatch is a measurement datapoint, not a proven model error.')
}

await main()
