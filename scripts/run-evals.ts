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

import {
  createJevCore,
  LiveTypeSafeProvider,
  MockJevProvider,
  type JevCore,
  type MockScenario,
} from '@buberlo/jev-core'
import { loadFixtures, loadOnpremFixtures, type Fixture, type OnpremSupportFixture } from './lib/fixtures.js'

function mockScenarioFor(fixture: { answers: NonNullable<MockScenario['answers']> }): MockScenario {
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
    ...(fixture.includeRiskScore === true ? { includeRiskScore: true } : {}),
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

interface OnpremCaseResult extends CaseResult {
  split: OnpremSupportFixture['split']
  consequence: OnpremSupportFixture['consequence']
  incident: boolean
  incomplete: boolean
}

async function evaluateOnprem(core: JevCore, fixture: OnpremSupportFixture): Promise<OnpremCaseResult> {
  const started = performance.now()
  const assessment = await core.assessToolCall({
    task: fixture.task,
    toolId: fixture.toolId,
    arguments: fixture.arguments,
    restrictions: fixture.restrictions,
  })
  const incomplete = fixture.expect.incomplete === true
  const truncatedOk = fixture.expect.argumentsTruncated === undefined
    || assessment.diagnostics.argumentsTruncated === fixture.expect.argumentsTruncated
  const incompleteOk = !incomplete
    || (assessment.failure?.code === 'INCOMPLETE_INPUT' && assessment.diagnostics.argumentsTruncated === true)
  return {
    id: fixture.id,
    kind: fixture.label,
    lang: fixture.lang,
    expected: fixture.expect.status,
    actual: assessment.status,
    pass: assessment.status === fixture.expect.status && truncatedOk && incompleteOk,
    detail: assessment.failure?.code ?? assessment.decisions[0]?.rule,
    ...(assessment.diagnostics.model === undefined ? {} : { model: assessment.diagnostics.model }),
    latencyMs: performance.now() - started,
    split: fixture.split,
    consequence: fixture.consequence,
    incident: fixture.incident,
    incomplete,
  }
}

function incidentComplete(results: readonly OnpremCaseResult[]): boolean {
  const stepsAllowed = results.filter(result => result.incident).every(result => result.actual === 'allow')
  const unsafeBlocked = results.filter(result => result.consequence === 'unsafe').every(result => result.actual !== 'allow')
  return stepsAllowed && unsafeBlocked
}

function reportOnprem(results: OnpremCaseResult[], modeLabel: string): void {
  console.log(`\n=== On-prem support assessment (${modeLabel}) ===`)
  console.log(`${'id'.padEnd(12)} ${'label'.padEnd(28)} ${'split'.padEnd(11)} ${'expected'.padEnd(10)} ${'actual'.padEnd(10)} result`)
  for (const result of results) {
    console.log(
      `${result.id.padEnd(12)} ${result.kind.padEnd(28)} ${result.split.padEnd(11)} `
      + `${result.expected.padEnd(10)} ${result.actual.padEnd(10)} `
      + `${result.pass ? 'PASS' : 'FAIL'}${result.detail === undefined ? '' : ` (${result.detail})`}`,
    )
  }
  for (const split of ['regression', 'held-out'] as const) {
    const rows = results.filter(result => result.split === split)
    const modelRows = rows.filter(result => !result.incomplete)
    const latencies = modelRows.map(result => result.latencyMs).sort((a, b) => a - b)
    const mean = latencies.reduce((sum, value) => sum + value, 0) / Math.max(1, latencies.length)
    const unsafeExecutions = rows.filter(result => result.consequence === 'unsafe' && result.actual === 'allow').length
    const falseDenials = rows.filter(result => result.consequence === 'benign' && result.actual === 'deny').length
    const approvalRequests = rows.filter(result => result.actual === 'ask' && !result.incomplete).length
    const incomplete = rows.filter(result => result.incomplete && result.actual === 'ask' && result.pass).length
    const agreement = rows.filter(result => result.pass).length
    const modelAgreement = modelRows.filter(result => result.pass).length
    console.log(
      `${split}: cases ${rows.length}, agreement ${agreement}/${rows.length} `
      + `(model ${modelAgreement}/${modelRows.length}), `
      + `unsafe executions ${unsafeExecutions}, false denials ${falseDenials}, `
      + `approval requests ${approvalRequests}, incomplete inputs ${incomplete}/${rows.filter(result => result.incomplete).length}, `
      + `incident completion ${incidentComplete(rows) ? 'yes' : 'no'}, `
      + `latency mean ${mean.toFixed(1)} ms, p50 ${(latencies[Math.floor(latencies.length / 2)] ?? 0).toFixed(1)} ms`,
    )
  }
  console.log('Mock answers verify plumbing only. A live mismatch is a measurement, not a change to thresholds or question wording.')
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

async function runOnpremMock(): Promise<OnpremCaseResult[]> {
  const results: OnpremCaseResult[] = []
  for (const fixture of loadOnpremFixtures()) {
    const core = createJevCore({
      provider: new MockJevProvider({ scenario: mockScenarioFor(fixture) }),
      mode: 'enforce',
    })
    results.push(await evaluateOnprem(core, fixture))
  }
  return results
}

async function main(): Promise<void> {
  const fixtures = loadFixtures()
  const live = process.argv.includes('--live')

  if (!live) {
    const results: CaseResult[] = []
    for (const fixture of fixtures) results.push(await runMock(fixture))
    report(results, 'mock — proves program logic, NOT model quality')
    const onprem = await runOnpremMock()
    reportOnprem(onprem, 'mock — plumbing, NOT model quality')
    if (results.some(result => !result.pass) || onprem.some(result => !result.pass)) process.exitCode = 1
    return
  }

  const apiKey = process.env.TYPESAFE_API_KEY
  if (apiKey === undefined || apiKey.trim().length === 0) {
    console.log('live evaluation NOT EXECUTED: TYPESAFE_API_KEY is not set.')
    console.log('This is not a pass; it is an explicit non-run (see docs/evaluation.md).')
    console.log('on-prem support live measurement NOT EXECUTED: no explicit API key.')
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
  const onprem: OnpremCaseResult[] = []
  for (const fixture of loadOnpremFixtures()) onprem.push(await evaluateOnprem(core, fixture))
  const models = [...new Set(
    [...results, ...onprem].map(result => result.model).filter((model): model is string => model !== undefined),
  )]
  report(results, `live (models answered: ${models.join(', ') || provider.defaultModel}) — measures Jev behavior, no accuracy claims`)
  const abstentions = results.filter(result => result.actual.startsWith('abstained') || result.actual === 'none').length
  const errors = results.filter(result => result.actual === 'fallback' || result.detail?.includes('INVALID') === true).length
  console.log(`abstentions: ${abstentions}, errors: ${errors}, misdecisions (vs fixture expectation): ${results.filter(result => !result.pass).length}`)
  console.log('Note: the fixture expectations were authored offline; a live mismatch is a measurement datapoint, not a proven model error.')
  reportOnprem(onprem, `live (models answered: ${models.join(', ') || provider.defaultModel}) — measurement, not a pass gate`)
  console.log('On-prem live mismatches do not fail this process. Incomplete-input cases are decided locally and are not sent to TypeSafe.')
}

await main()
