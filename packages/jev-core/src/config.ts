/**
 * Core configuration: thresholds, bounds, and per-function failure rules.
 *
 * Thresholds are deliberately uncalibrated defaults: they are a starting point
 * for the target application, not measured operating points. Document any
 * deployment-specific calibration next to the config that carries it.
 *
 * @module jev-core/config
 */

import { JevError } from './errors.js'
import { DEFAULT_REDACT_KEYS } from './redact.js'
import type { JevMode, JevProvider } from './types.js'

/** Decision thresholds. Noul and confidence thresholds are probabilities in [0, 1]. */
export interface JevThresholds {
  /** Minimum relevance probability for a category or skill to count as relevant. */
  readonly relevance: number
  /** Minimum probability of the selected candidate before it is treated as a clear winner. */
  readonly selection: number
  /** Minimum reported confidence before a choice answer is acted on. */
  readonly confidence: number
  /** At or above this probability a restriction violation blocks the call. */
  readonly restriction: number
  /** At or above this probability missing information forces an approval. */
  readonly missingInformation: number
  /** Below this probability the call does not match the task, forcing an approval. */
  readonly taskMatch: number
  /** Minimum probability that the turn needs a skill. */
  readonly skill: number
  /** Minimum probability of the selected model route. */
  readonly modelRoute: number
}

/** Hard bounds applied to every provider request and to local bookkeeping. */
export interface JevLimits {
  /** Whole-call time budget in milliseconds, including SDK retries. */
  readonly budgetMs: number
  /** Maximum concurrent provider requests. */
  readonly maxConcurrent: number
  /** Maximum characters of `state` sent with a request. */
  readonly maxStateChars: number
  /** Maximum characters kept from one serialized argument value. */
  readonly maxArgumentChars: number
  /** Maximum categories asked in one selection batch before it is staged. */
  readonly maxCategories: number
  /** Maximum candidates placed in one choice question. */
  readonly maxCandidatesPerQuestion: number
  /** Hard cap for one choice question (TypeSafe documents 255 options). */
  readonly maxOptionsPerQuestion: number
  /** Maximum array entries and object keys kept while bounding a value. */
  readonly maxArrayItems: number
  /** Maximum object depth kept while bounding a value. */
  readonly maxDepth: number
  /** Maximum skills considered in one skill-routing request. */
  readonly maxSkills: number
  /** Maximum tools one selection may keep visible. */
  readonly maxSelectedTools: number
}

/**
 * What happens per function when a required assessment produced no usable
 * result. Tool assessment may only ask or hold — deriving a permission from a
 * failure is rejected at configuration time.
 */
export interface JevFailurePolicy {
  readonly toolSelection: 'fallback'
  readonly toolAssessment: 'ask' | 'hold'
  readonly skillRouting: 'fallback'
  readonly modelRouting: 'fallback'
}

/** Complete, resolved core configuration. */
export interface JevCoreConfig {
  readonly provider: JevProvider
  readonly mode: JevMode
  /** Model override passed to the provider; omitted uses the provider default. */
  readonly model?: string
  readonly thresholds: JevThresholds
  readonly limits: JevLimits
  readonly onFailure: JevFailurePolicy
  readonly redactKeys: readonly string[]
}

/** Partial configuration accepted by {@link createJevCoreConfig}. */
export interface JevCoreConfigInput {
  readonly provider: JevProvider
  readonly mode?: JevMode
  readonly model?: string
  readonly thresholds?: Partial<JevThresholds>
  readonly limits?: Partial<JevLimits>
  readonly onFailure?: Partial<JevFailurePolicy>
  readonly redactKeys?: readonly string[]
}

/**
 * Documented starting thresholds. Not calibrated for any target application;
 * treat them as placeholders that deployments tune against their own data.
 */
export const DEFAULT_THRESHOLDS: JevThresholds = {
  relevance: 0.5,
  selection: 0.35,
  confidence: 0.3,
  restriction: 0.5,
  missingInformation: 0.5,
  taskMatch: 0.35,
  skill: 0.5,
  modelRoute: 0.4,
}

/** Conservative resource defaults for an interactive agent. */
export const DEFAULT_LIMITS: JevLimits = {
  budgetMs: 8000,
  maxConcurrent: 2,
  maxStateChars: 4000,
  maxArgumentChars: 1200,
  maxCategories: 8,
  maxCandidatesPerQuestion: 40,
  maxOptionsPerQuestion: 255,
  maxArrayItems: 24,
  maxDepth: 4,
  maxSkills: 20,
  maxSelectedTools: 12,
}

/** Failure defaults: selection keeps the existing flow, assessment gates. */
export const DEFAULT_FAILURE_POLICY: JevFailurePolicy = {
  toolSelection: 'fallback',
  toolAssessment: 'ask',
  skillRouting: 'fallback',
  modelRouting: 'fallback',
}

function assertThreshold(name: string, value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new JevError('INVALID_CONFIG', `threshold "${name}" must be a number in [0, 1]`)
  }
  return value
}

function assertPositiveInt(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new JevError('INVALID_CONFIG', `limit "${name}" must be a positive integer`)
  }
  return value
}

/**
 * Merge, validate, and freeze a core configuration.
 * @param input - provider plus optional overrides.
 * @returns the resolved configuration.
 * @throws {JevError} with code `INVALID_CONFIG` on any invalid field.
 */
export function createJevCoreConfig(input: JevCoreConfigInput): JevCoreConfig {
  if (input.provider === undefined || input.provider === null || typeof input.provider.ask !== 'function') {
    throw new JevError('INVALID_CONFIG', 'a provider with an ask() method is required')
  }
  const mode: JevMode = input.mode ?? 'shadow'
  if (mode !== 'off' && mode !== 'shadow' && mode !== 'enforce') {
    throw new JevError('INVALID_CONFIG', `mode must be off, shadow or enforce; got ${String(mode)}`)
  }

  const thresholds: JevThresholds = { ...DEFAULT_THRESHOLDS }
  for (const [key, value] of Object.entries(input.thresholds ?? {})) {
    if (value === undefined) continue
    assertThreshold(key, value)
    ;(thresholds as unknown as Record<string, number>)[key] = value
  }

  const limits: JevLimits = { ...DEFAULT_LIMITS }
  for (const [key, value] of Object.entries(input.limits ?? {})) {
    if (value === undefined) continue
    assertPositiveInt(key, value)
    ;(limits as unknown as Record<string, number>)[key] = value
  }
  if (limits.maxCandidatesPerQuestion > limits.maxOptionsPerQuestion) {
    throw new JevError('INVALID_CONFIG', 'maxCandidatesPerQuestion must not exceed maxOptionsPerQuestion')
  }

  const assessmentFailure = input.onFailure?.toolAssessment ?? DEFAULT_FAILURE_POLICY.toolAssessment
  if (assessmentFailure !== 'ask' && assessmentFailure !== 'hold') {
    throw new JevError(
      'INVALID_CONFIG',
      'onFailure.toolAssessment must be "ask" or "hold": a missing execution assessment must never become a permission',
    )
  }
  const onFailure: JevFailurePolicy = {
    toolSelection: 'fallback',
    toolAssessment: assessmentFailure,
    skillRouting: 'fallback',
    modelRouting: 'fallback',
  }

  return Object.freeze({
    provider: input.provider,
    mode,
    ...(input.model === undefined ? {} : { model: input.model }),
    thresholds: Object.freeze(thresholds),
    limits: Object.freeze(limits),
    onFailure: Object.freeze(onFailure),
    redactKeys: Object.freeze([...(input.redactKeys ?? DEFAULT_REDACT_KEYS)]),
  })
}
