/**
 * Threshold calibration over the versioned fixtures.
 *
 * Measures every case once (values are independent of the thresholds), then
 * sweeps the decision thresholds in code and reports agreement with the
 * fixture expectations. This separates model measurements from threshold
 * choices: re-running the model is not needed to explore thresholds.
 *
 * Honesty rules baked into the output:
 * - mock mode calibrates the plumbing, never real thresholds (synthetic values);
 * - the sample is tiny; the output is a starting point, not a calibrated
 *   operating point for any deployment.
 *
 * Usage:
 *   pnpm calibrate
 *   TYPESAFE_API_KEY=... pnpm calibrate -- --live
 */

import {
  createJevCore,
  LiveTypeSafeProvider,
  MockJevProvider,
  type JevCore,
  type MockScenario,
} from '@buberlo/jev-core'
import { loadFixtures, type AssessmentFixture, type SelectionFixture } from './lib/fixtures.js'

const STEPS = Array.from({ length: 19 }, (_, index) => Number(((index + 1) * 0.05).toFixed(2)))

interface AssessmentMeasurement {
  id: string
  expected: string
  matchesTask?: number
  missingInformation?: number
  violatesRestriction?: number
  failure?: string
  latencyMs: number
}

interface CategoryMeasurement {
  id: string
  relevance: number
  choice: string
  probability: number
  confidence: number
}

interface SelectionMeasurement {
  id: string
  expectedStatus: string
  expected: string[]
  categories: CategoryMeasurement[]
  failure?: string
  latencyMs: number
}

function buildCore(live: boolean): JevCore {
  const provider = live
    ? new LiveTypeSafeProvider({
      apiKey: process.env.TYPESAFE_API_KEY as string,
      ...(process.env.TYPESAFE_MODEL === undefined ? {} : { model: process.env.TYPESAFE_MODEL }),
      maxRetries: 1,
      timeoutMs: 20000,
    })
    : new MockJevProvider()
  return createJevCore({
    provider,
    mode: 'enforce',
    // Raw measurements: every category is asked, no decision gate is applied
    // before the sweep. The provider answers are independent of these values.
    thresholds: { relevance: 0, selection: 0, confidence: 0 },
    limits: { budgetMs: live ? 30000 : 8000 },
  })
}

function mockScenarioFor(fixture: AssessmentFixture | SelectionFixture): MockScenario {
  return { answers: fixture.answers, model: 'mock/jev-calibration', usage: { input_tokens: 0, output_tokens: 0 } }
}

async function measureAssessment(core: JevCore, fixture: AssessmentFixture): Promise<AssessmentMeasurement> {
  const started = performance.now()
  const assessment = await core.assessToolCall({
    task: fixture.task,
    toolId: fixture.toolId,
    arguments: fixture.arguments,
    restrictions: fixture.restrictions,
    ...(fixture.includeRiskScore === true ? { includeRiskScore: true } : {}),
  })
  return {
    id: fixture.id,
    expected: fixture.expect.status,
    ...(assessment.values.matchesTask === undefined ? {} : { matchesTask: assessment.values.matchesTask }),
    ...(assessment.values.missingInformation === undefined ? {} : { missingInformation: assessment.values.missingInformation }),
    ...(assessment.values.violatesRestriction === undefined ? {} : { violatesRestriction: assessment.values.violatesRestriction }),
    ...(assessment.failure === undefined ? {} : { failure: assessment.failure.code }),
    latencyMs: performance.now() - started,
  }
}

async function measureSelection(core: JevCore, fixture: SelectionFixture): Promise<SelectionMeasurement> {
  const started = performance.now()
  const plan = await core.selectTools({
    task: fixture.task,
    ...(fixture.step === undefined ? {} : { step: fixture.step }),
    candidates: fixture.candidates,
    categories: fixture.categories,
  })
  return {
    id: fixture.id,
    expectedStatus: fixture.expect.status,
    expected: [...fixture.expect.selected].sort(),
    categories: plan.categories.map(category => ({
      id: category.category,
      relevance: category.relevance,
      choice: category.pick?.choice ?? '__none__',
      probability: category.pick?.probability ?? 0,
      confidence: category.pick?.confidence ?? 0,
    })),
    ...(plan.failure === undefined ? {} : { failure: plan.failure.code }),
    latencyMs: performance.now() - started,
  }
}

function assessmentDecision(
  measurement: AssessmentMeasurement,
  thresholds: { restriction: number; missingInformation: number; taskMatch: number },
): string {
  if ((measurement.violatesRestriction ?? 0) >= thresholds.restriction) return 'deny'
  if ((measurement.missingInformation ?? 0) >= thresholds.missingInformation) return 'ask'
  if ((measurement.matchesTask ?? 1) < thresholds.taskMatch) return 'ask'
  return 'allow'
}

function selectionDecision(
  measurement: SelectionMeasurement,
  thresholds: { relevance: number; selection: number; confidence: number },
): { status: string; selected: string[] } {
  const selected = new Set<string>()
  for (const category of measurement.categories) {
    if (category.choice === '__none__' || category.choice.length === 0) continue
    if (
      category.relevance >= thresholds.relevance
      && category.probability >= thresholds.selection
      && category.confidence >= thresholds.confidence
    ) {
      selected.add(category.choice)
    }
  }
  const sorted = [...selected].sort()
  return { status: sorted.length > 0 ? 'selected' : 'abstained', selected: sorted }
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function passAssessment(measurements: readonly AssessmentMeasurement[], thresholds: { restriction: number; missingInformation: number; taskMatch: number }): number {
  return measurements.filter(measurement =>
    measurement.failure === undefined && assessmentDecision(measurement, thresholds) === measurement.expected).length
}

function passSelection(measurements: readonly SelectionMeasurement[], thresholds: { relevance: number; selection: number; confidence: number }): number {
  return measurements.filter((measurement) => {
    if (measurement.failure !== undefined) return false
    const decision = selectionDecision(measurement, thresholds)
    return decision.status === measurement.expectedStatus && sameSet(decision.selected, measurement.expected)
  }).length
}

function printAssessmentReport(measurements: readonly AssessmentMeasurement[]): void {
  console.log('\n--- assessment measurements ---')
  console.log(`${'id'.padEnd(14)} ${'expected'.padEnd(8)} matches missing violates  failure`)
  for (const measurement of measurements) {
    const value = (input: number | undefined): string => input === undefined ? '  -  ' : input.toFixed(2)
    console.log(
      `${measurement.id.padEnd(14)} ${measurement.expected.padEnd(8)} `
      + `${value(measurement.matchesTask).padEnd(7)} ${value(measurement.missingInformation).padEnd(7)} `
      + `${value(measurement.violatesRestriction).padEnd(8)} ${measurement.failure ?? ''}`,
    )
  }

  const usable = measurements.filter(measurement => measurement.failure === undefined)
  let best = { score: -1, combos: [] as Array<{ restriction: number; missingInformation: number; taskMatch: number }> }
  for (const restriction of STEPS) {
    for (const missingInformation of STEPS) {
      for (const taskMatch of STEPS) {
        const score = passAssessment(usable, { restriction, missingInformation, taskMatch })
        if (score > best.score) best = { score, combos: [{ restriction, missingInformation, taskMatch }] }
        else if (score === best.score && best.combos.length < 5000) best.combos.push({ restriction, missingInformation, taskMatch })
      }
    }
  }
  const defaults = passAssessment(usable, { restriction: 0.5, missingInformation: 0.5, taskMatch: 0.35 })
  console.log(`\nthreshold grid: ${STEPS.length ** 3} combinations over ${usable.length} usable case(s)`)
  console.log(`defaults (0.50 / 0.50 / 0.35): ${defaults}/${usable.length}`)
  if (best.score === usable.length) {
    const range = (pick: (combo: typeof best.combos[number]) => number): string => {
      const values = best.combos.map(pick)
      return `${Math.min(...values).toFixed(2)}..${Math.max(...values).toFixed(2)}`
    }
    console.log(`perfect agreement: ${best.score}/${usable.length} in ${best.combos.length} combinations`)
    console.log(`  restriction        ∈ ${range(combo => combo.restriction)}`)
    console.log(`  missingInformation ∈ ${range(combo => combo.missingInformation)}`)
    console.log(`  taskMatch          ∈ ${range(combo => combo.taskMatch)}`)
    console.log('  (a range, not a point: the sample cannot separate values inside it)')
  } else {
    console.log(`best agreement: ${best.score}/${usable.length} (first: ${JSON.stringify(best.combos[0])})`)
    for (const measurement of usable) {
      const decided = assessmentDecision(measurement, best.combos[0] as NonNullable<typeof best.combos[0]>)
      if (decided !== measurement.expected) {
        console.log(`  disagreement: ${measurement.id} expected=${measurement.expected} decided=${decided}`)
      }
    }
  }
}

function printSelectionReport(measurements: readonly SelectionMeasurement[]): void {
  console.log('\n--- selection measurements ---')
  for (const measurement of measurements) {
    console.log(`${measurement.id} expected=${measurement.expected.join(',') || '(none)'} failure=${measurement.failure ?? '-'}`)
    for (const category of measurement.categories) {
      console.log(
        `  ${category.id.padEnd(14)} relevance=${category.relevance.toFixed(2)} choice=${category.choice.padEnd(16)} `
        + `p=${category.probability.toFixed(2)} conf=${category.confidence.toFixed(2)}`,
      )
    }
  }

  const usable = measurements.filter(measurement => measurement.failure === undefined)
  const scores: Array<{ score: number; thresholds: { relevance: number; selection: number; confidence: number } }> = []
  for (const relevance of STEPS) {
    for (const selection of STEPS) {
      for (const confidence of STEPS) {
        scores.push({
          score: passSelection(usable, { relevance, selection, confidence }),
          thresholds: { relevance, selection, confidence },
        })
      }
    }
  }
  const best = Math.max(...scores.map(entry => entry.score))
  const winners = scores.filter(entry => entry.score === best)
  const defaults = passSelection(usable, { relevance: 0.5, selection: 0.35, confidence: 0.3 })
  console.log(`\nthreshold grid: ${STEPS.length ** 3} combinations over ${usable.length} usable case(s)`)
  console.log(`defaults (0.50 / 0.35 / 0.30): ${defaults}/${usable.length}`)
  console.log(`best agreement: ${best}/${usable.length} in ${winners.length} combination(s)`)
  if (winners.length > 0 && winners[0] !== undefined) {
    const range = (pick: (entry: typeof scores[number]) => number): string => {
      const values = winners.map(pick)
      return `${Math.min(...values).toFixed(2)}..${Math.max(...values).toFixed(2)}`
    }
    console.log(`  relevance  ∈ ${range(entry => entry.thresholds.relevance)}`)
    console.log(`  selection  ∈ ${range(entry => entry.thresholds.selection)}`)
    console.log(`  confidence ∈ ${range(entry => entry.thresholds.confidence)}`)
    console.log('  (ranges reflect the small sample; treat as a starting region)')
  }
}

async function main(): Promise<void> {
  const live = process.argv.includes('--live')
  if (live) {
    const key = process.env.TYPESAFE_API_KEY
    if (key === undefined || key.trim().length === 0) {
      console.log('live calibration NOT EXECUTED: TYPESAFE_API_KEY is not set (not a pass).')
      return
    }
  }
  const fixtures = loadFixtures()
  const selectionFixtures = fixtures.filter((fixture): fixture is SelectionFixture => fixture.kind === 'selection')
  const assessmentFixtures = fixtures.filter((fixture): fixture is AssessmentFixture => fixture.kind === 'assessment')
  const core = buildCore(live)

  console.log(`=== threshold calibration (${live ? 'live' : 'mock — plumbing only, NOT real thresholds'}) ===`)
  console.log(`selection cases: ${selectionFixtures.length}, assessment cases: ${assessmentFixtures.length}`)

  const assessments: AssessmentMeasurement[] = []
  const selections: SelectionMeasurement[] = []
  for (const fixture of assessmentFixtures) {
    const measurement = await measureAssessment(mockCore(live, fixture, core), fixture)
    assessments.push(measurement)
  }
  for (const fixture of selectionFixtures) {
    const measurement = await measureSelection(mockCore(live, fixture, core), fixture)
    selections.push(measurement)
  }

  printAssessmentReport(assessments)
  printSelectionReport(selections)

  const latencies = [...assessments, ...selections].map(measurement => measurement.latencyMs)
  const mean = latencies.reduce((sum, value) => sum + value, 0) / Math.max(1, latencies.length)
  console.log(`\nmeasurement latency: mean ${mean.toFixed(0)} ms over ${latencies.length} case(s)`)
  console.log('\nCalibration notes:')
  console.log('- Mock mode proves the sweep plumbing; its values are synthetic and must not be copied.')
  console.log('- A range with perfect agreement is not a calibrated operating point; collect labelled')
  console.log('  cases per consequence class, then re-run against them.')
  if (live) console.log('- Live values came from real Jev answers; the sample is deliberately tiny.')
}

/** In mock mode each fixture carries its own scenario; live mode shares one core. */
function mockCore(live: boolean, fixture: AssessmentFixture | SelectionFixture, liveCore: JevCore): JevCore {
  if (live) return liveCore
  return createJevCore({
    provider: new MockJevProvider({ scenario: mockScenarioFor(fixture) }),
    mode: 'enforce',
    thresholds: { relevance: 0, selection: 0, confidence: 0 },
  })
}

await main()
