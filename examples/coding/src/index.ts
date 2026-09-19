/**
 * Coding-assistant example (offline, synthetic).
 *
 * Shows the full vertical slice on `@buberlo/jev-core` alone:
 * synthetic task → independent category relevance questions → per-category
 * candidate choice → deterministic policy → tool-call assessment.
 *
 * Every model value in this example is SYNTHETIC: the provider is the
 * deterministic mock, the model id is `mock/jev-synthetic`, and the numbers
 * were chosen by the example author, not measured on any real workload.
 *
 * Run: pnpm example:coding   (build the workspace first: pnpm build)
 */

import {
  createJevCore,
  MockJevProvider,
  type MockAnswerSpec,
  type MockScenario,
  type JevCore,
} from '@buberlo/jev-core'

const CANDIDATES = [
  { id: 'read_file', categories: ['files'], description: 'Read a file from the workspace', priority: 1 },
  { id: 'write_file', categories: ['files'], description: 'Write a file in the workspace', priority: 2 },
  { id: 'grep', categories: ['search'], description: 'Search file contents by pattern' },
  { id: 'run_tests', categories: ['tests'], description: 'Run the repository test suite' },
  { id: 'git_commit', categories: ['git'], description: 'Commit staged changes' },
] as const

const CATEGORIES = [
  { id: 'files', description: 'Reading or writing workspace files' },
  { id: 'search', description: 'Searching file contents' },
  { id: 'tests', description: 'Running or inspecting tests' },
  { id: 'git', description: 'Version-control operations' },
]

/** Synthetic answers: the task needs files + tests, not git or search. */
const SELECTION_ANSWERS: Record<string, MockAnswerSpec> = {
  rel_files: { noul: 0.97 },
  rel_search: { noul: 0.2 },
  rel_tests: { noul: 0.93 },
  rel_git: { noul: 0.15 },
  pick_files: { choice: { choice: 'read_file', confidence: 0.88 } },
  pick_tests: { choice: { choice: 'run_tests', confidence: 0.91 } },
}

/** Synthetic assessment: the read matches, nothing is missing, no conflict. */
const ASSESSMENT_OK: Record<string, MockAnswerSpec> = {
  matches_task: { noul: 0.96 },
  missing_information: { noul: 0.06 },
  violates_restriction: { noul: 0.04 },
  risk: { score: { score: 1.1, confidence: 0.62 } },
}

function syntheticProvider(): MockJevProvider {
  return new MockJevProvider({
    scenarioFor: (request): MockScenario => {
      const answers: Record<string, MockAnswerSpec> = {}
      for (const questionId of Object.keys(request.questions)) {
        if (questionId in SELECTION_ANSWERS) answers[questionId] = SELECTION_ANSWERS[questionId] as MockAnswerSpec
        else if (questionId in ASSESSMENT_OK) answers[questionId] = ASSESSMENT_OK[questionId] as MockAnswerSpec
        else answers[questionId] = { noul: 0.5 }
      }
      return { answers }
    },
  })
}

function printHeader(title: string): void {
  console.log(`\n=== ${title} ===`)
}

function printPlan(core: JevCore, plan: Awaited<ReturnType<JevCore['selectTools']>>): void {
  console.log(`provider : ${plan.diagnostics.provider} (model: ${plan.diagnostics.model ?? 'n/a'})`)
  console.log(`mode     : ${plan.diagnostics.mode}`)
  console.log(`stages   : ${plan.diagnostics.stages.join(' → ')}`)
  console.log('categories (independent relevance questions):')
  for (const category of plan.categories) {
    const pick = category.pick === undefined
      ? ''
      : `, pick=${category.pick.choice} p=${category.pick.probability.toFixed(2)} conf=${category.pick.confidence.toFixed(2)}`
    console.log(`  - ${category.category.padEnd(8)} relevance=${category.relevance.toFixed(2)} relevant=${String(category.relevant)}${pick}`)
  }
  console.log(`selected : ${plan.selected.join(', ') || '(none)'}`)
  console.log(`expand   : ${plan.expand.join(', ') || '(none)'}`)
  console.log(`status   : ${plan.status}`)
  void core
}

async function main(): Promise<void> {
  const provider = syntheticProvider()
  const core = createJevCore({
    provider,
    mode: 'enforce',
    thresholds: { relevance: 0.5, selection: 0.35, confidence: 0.3 },
  })

  const task = 'Fix the failing billing test: read src/billing.test.ts and run the test suite to confirm the failure.'
  const step = 'Inspect the failing test and reproduce it'

  printHeader('1. Dynamic tool selection')
  console.log(`input task : ${task}`)
  console.log(`candidates : ${CANDIDATES.map(candidate => candidate.id).join(', ')} (all synthetic tools)`)
  const plan = await core.selectTools({
    task,
    step,
    candidates: [...CANDIDATES],
    categories: CATEGORIES,
  })
  printPlan(core, plan)

  printHeader('2. Pre-execution assessment (proposed model call)')
  const call = { toolId: 'write_file', arguments: { path: '/repo/src/billing.test.ts', content: 'fixed' } }
  console.log(`proposed   : ${call.toolId} ${JSON.stringify(call.arguments)}`)
  const assessment = await core.assessToolCall({
    task,
    step,
    toolId: call.toolId,
    arguments: call.arguments,
    restrictions: ['do not modify files outside /repo/src'],
    includeRiskScore: true,
  })
  console.log(`policy     : ${assessment.status} (applied=${String(assessment.applied)})`)
  for (const decision of assessment.decisions) {
    console.log(`  - ${decision.rule}: ${decision.reason} [action=${decision.action}, applied=${String(decision.applied)}]`)
  }
  console.log(`values     : matches=${assessment.values.matchesTask} missing=${assessment.values.missingInformation} violates=${assessment.values.violatesRestriction}`)
  if (assessment.values.risk !== undefined) {
    console.log(`risk score : ${assessment.values.risk.score.toFixed(2)} (ordinal, 0–2; confidence=${assessment.values.risk.confidence.toFixed(2)}) — not a risk percentage`)
  }
  console.log(`signature  : ${assessment.diagnostics.signature.slice(0, 16)}… (bound to tool id + bounded arguments)`)
  console.log(`effect     : ${assessment.status === 'allow' && assessment.applied ? 'execution would proceed' : 'execution would be gated by the harness adapter'}`)
  console.log('\nAll values above are SYNTHETIC mock answers, not measured model behavior.')
}

await main()
