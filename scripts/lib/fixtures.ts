/**
 * Shared evaluation fixture vocabulary and loader.
 *
 * One JSONL line is one case; `answers` drives mock mode, `expect` is the
 * reference outcome for both modes. Live mode ignores `answers`.
 *
 * @module scripts/lib/fixtures
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { MockAnswerSpec, SkillCandidateInfo } from '@buberlo/jev-core'

/** One selectable tool in a selection fixture. */
export interface FixtureCandidate {
  id: string
  categories: string[]
  description?: string
  restricted?: boolean
}

/** One tool-selection case. */
export interface SelectionFixture {
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

/** One call-assessment case. */
export interface AssessmentFixture {
  id: string
  lang: 'en' | 'de'
  kind: 'assessment'
  task: string
  toolId: string
  arguments: unknown
  restrictions: string[]
  /** Ask the optional ordinal risk-score question too. */
  includeRiskScore?: boolean
  answers: Record<string, MockAnswerSpec>
  expect: { status: string }
}

/** One skill-routing case. */
export interface SkillFixture {
  id: string
  lang: 'en' | 'de'
  kind: 'skill'
  task: string
  step?: string
  candidates: SkillCandidateInfo[]
  answers: Record<string, MockAnswerSpec>
  expect: { status: string; skill?: string }
}

/** One evaluation case. */
export type Fixture = SelectionFixture | AssessmentFixture | SkillFixture

/** Load the versioned fixture set in file order. */
export function loadFixtures(): Fixture[] {
  const path = fileURLToPath(new URL('../../evals/fixtures/decisions.v1.jsonl', import.meta.url))
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as Fixture)
}

/** Labeled outcome class for one on-prem support call. */
export type OnpremConsequence = 'benign' | 'unsafe' | 'needs-approval' | 'incomplete'

/** Which measurement bucket a support case belongs to. */
export type OnpremSplit = 'regression' | 'held-out'

/** One labeled on-prem support assessment. Mock `answers` are plumbing only. */
export interface OnpremSupportFixture {
  id: string
  lang: 'en' | 'de'
  kind: 'assessment'
  suite: 'onprem-support'
  label: string
  split: OnpremSplit
  consequence: OnpremConsequence
  /** When true, the incident counts as completed only if this call is allowed. */
  incident: boolean
  scope: 'explicit' | 'missing' | 'none'
  task: string
  toolId: string
  arguments: Record<string, unknown>
  restrictions: string[]
  answers: Record<string, MockAnswerSpec>
  expect: {
    status: 'allow' | 'ask' | 'hold' | 'deny'
    executed: boolean
    incomplete?: boolean
    argumentsTruncated?: boolean
    rule?: string
  }
}

const ONPREM_STATUSES = new Set(['allow', 'ask', 'hold', 'deny'])
const ONPREM_CONSEQUENCES = new Set(['benign', 'unsafe', 'needs-approval', 'incomplete'])
const ONPREM_SPLITS = new Set(['regression', 'held-out'])
const ONPREM_SCOPES = new Set(['explicit', 'missing', 'none'])

/**
 * Load the versioned on-prem support regression set.
 * These cases are not part of the 25-fixture calibration sweep.
 */
export function loadOnpremFixtures(): OnpremSupportFixture[] {
  const path = fileURLToPath(new URL('../../evals/fixtures/onprem-support.v1.jsonl', import.meta.url))
  const fixtures = readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as OnpremSupportFixture)
  const ids = new Set<string>()
  for (const fixture of fixtures) {
    if (fixture.suite !== 'onprem-support' || fixture.kind !== 'assessment') {
      throw new Error(`on-prem fixture ${fixture.id} has an unexpected suite or kind`)
    }
    if (ids.has(fixture.id)) throw new Error(`duplicate on-prem fixture id ${fixture.id}`)
    ids.add(fixture.id)
    if (!ONPREM_STATUSES.has(fixture.expect.status)) {
      throw new Error(`on-prem fixture ${fixture.id} has an unexpected status`)
    }
    if (!ONPREM_CONSEQUENCES.has(fixture.consequence)) {
      throw new Error(`on-prem fixture ${fixture.id} has an unexpected consequence`)
    }
    if (!ONPREM_SPLITS.has(fixture.split)) throw new Error(`on-prem fixture ${fixture.id} has an unexpected split`)
    if (!ONPREM_SCOPES.has(fixture.scope)) throw new Error(`on-prem fixture ${fixture.id} has an unexpected scope`)
    if (fixture.consequence === 'incomplete' && fixture.expect.incomplete !== true) {
      throw new Error(`on-prem fixture ${fixture.id} is incomplete but expect.incomplete is not set`)
    }
  }
  return fixtures
}
