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
