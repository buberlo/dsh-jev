/**
 * Read-only ops router example (offline, synthetic).
 *
 * An incident report is routed onto diagnostic tools. The candidate set is
 * bounded and read-only; a remediation tool exists only to show that the
 * deterministic policy never selects it for this incident. No customer system
 * is contacted: every tool is synthetic and only prints what it would inspect.
 *
 * All model values are SYNTHETIC mock answers.
 *
 * Run: pnpm example:ops   (build the workspace first: pnpm build)
 */

import {
  createJevCore,
  MockJevProvider,
  type MockAnswerSpec,
  type MockScenario,
} from '@buberlo/jev-core'

const CANDIDATES = [
  { id: 'query_metrics', categories: ['monitoring'], description: 'Query time-series metrics for a service', priority: 1 },
  { id: 'fetch_host_events', categories: ['host-events'], description: 'Read kernel and service events for a host', priority: 2 },
  { id: 'inspect_storage', categories: ['storage'], description: 'Read disk usage, latency, and IO queue state', priority: 3 },
  { id: 'tail_logs', categories: ['logs'], description: 'Read the last log lines of a service', priority: 4 },
  { id: 'restart_service', categories: ['remediation'], description: 'Restart a service (mutating)', priority: 5 },
] as const

const CATEGORIES = [
  { id: 'monitoring', description: 'Metric and time-series inspection (read-only)' },
  { id: 'host-events', description: 'Host and kernel event inspection (read-only)' },
  { id: 'storage', description: 'Disk and storage state inspection (read-only)' },
  { id: 'logs', description: 'Log inspection (read-only)' },
  { id: 'remediation', description: 'Mutating remediation actions' },
]

/** Synthetic answers: this incident is a disk-latency question, not a restart. */
const ANSWERS: Record<string, MockAnswerSpec> = {
  rel_monitoring: { noul: 0.93 },
  rel_host_events: { noul: 0.81 },
  rel_storage: { noul: 0.97 },
  rel_logs: { noul: 0.42 },
  rel_remediation: { noul: 0.03 },
  pick_monitoring: { choice: { choice: 'query_metrics', confidence: 0.9 } },
  pick_host_events: { choice: { choice: 'fetch_host_events', confidence: 0.86 } },
  pick_storage: { choice: { choice: 'inspect_storage', confidence: 0.94 } },
}

const provider = new MockJevProvider({
  scenarioFor: (request): MockScenario => ({
    answers: Object.fromEntries(Object.keys(request.questions).map((id): [string, MockAnswerSpec] => [
      id, ANSWERS[id] ?? { noul: 0.5 },
    ])),
  }),
})

const core = createJevCore({ provider, mode: 'enforce' })

const incident = [
  'Incident INC-4711 (synthetic): since 09:12 UTC, p99 latency of checkout-service',
  'rose from 180ms to 2.4s. Host web-12 reports elevated IO wait; nothing was deployed',
  'today. Do not restart anything until the cause is understood.',
].join(' ')

console.log('=== read-only ops router (SYNTHETIC) ===')
console.log(`incident : ${incident}`)
console.log(`policy   : do not restart anything until the cause is understood`)

const plan = await core.selectTools({
  task: incident,
  step: 'collect read-only diagnostics for web-12',
  candidates: [...CANDIDATES],
  categories: CATEGORIES,
})

console.log(`\nprovider : ${plan.diagnostics.provider} (SYNTHETIC model mock/jev-synthetic)`)
console.log(`mode     : ${plan.diagnostics.mode}`)
console.log('candidates and independent relevance:')
for (const category of plan.categories) {
  console.log(`  - ${category.category.padEnd(13)} relevance=${category.relevance.toFixed(2)} relevant=${String(category.relevant)}`)
}
console.log(`\nselected diagnostics : ${plan.selected.join(', ')}`)
console.log(`not selected         : restart_service (relevance below threshold; policy is read-only until a cause is found)`)
console.log(`status               : ${plan.status}`)

const remediation = plan.categories.find(category => category.category === 'remediation')
console.log(`remediation noul     : ${remediation?.relevance.toFixed(2)} (synthetic; below the ${0.5} relevance threshold)`)
console.log('\nNote: the restart tool was never sent as a preferred candidate, and the example policy never selects it.')
