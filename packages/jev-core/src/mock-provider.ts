/**
 * Deterministic offline Jev provider.
 *
 * The mock exists so every policy, adapter, and example can be exercised
 * without network access and without an API key. All values it produces are
 * synthetic: the provider id is `mock` and the model identifier defaults to
 * `mock/jev-synthetic`.
 *
 * @module jev-core/mock-provider
 */

import type { Questions, Usage } from '@typesafe-ai/sdk'
import { JevError, type JevErrorCode } from './errors.js'
import type { JevCallOptions, JevProvider, JevProviderReply, JevProviderRequest } from './types.js'
import { validateReply } from './validate.js'

/** Explicit mock distribution for a choice answer. */
export interface MockChoiceAnswer {
  readonly choice: string
  readonly confidence?: number
  /** Full distribution; when omitted a deterministic one is derived from `confidence`. */
  readonly probabilities?: Readonly<Record<string, number>>
}

/** Explicit mock values for a score answer. */
export interface MockScoreAnswer {
  readonly score: number
  readonly confidence?: number
  readonly probabilities?: Readonly<Record<string, number>>
}

/** One per-question mock answer. */
export interface MockAnswerSpec {
  readonly choice?: string | MockChoiceAnswer
  readonly score?: number | MockScoreAnswer
  readonly noul?: number
  /** Omit the answer entirely (simulates a missing answer). */
  readonly omit?: boolean
  /** Emit a different answer type than the question (simulates a type mismatch). */
  readonly wrongType?: 'choice' | 'score' | 'noul'
}

/** One fully specified mock reply, including failure injection. */
export interface MockScenario {
  readonly answers?: Readonly<Record<string, MockAnswerSpec>>
  readonly model?: string
  readonly usage?: Usage
  /** Throw this error instead of answering. */
  readonly error?: { readonly code: JevErrorCode; readonly message?: string; readonly retryable?: boolean }
}

/** Construction options for {@link MockJevProvider}. */
export interface MockJevProviderOptions {
  /** Scenario applied to every call unless `scenarioFor` returns one. */
  readonly scenario?: MockScenario
  /** Per-call scenario selector, evaluated in call order. */
  readonly scenarioFor?: (request: JevProviderRequest<Questions>, callIndex: number) => MockScenario | undefined
  /** Default model identifier reported in replies. */
  readonly model?: string
  /** Artificial latency, useful for cancellation and stale-result tests. */
  readonly delayMs?: number
}

/** The model identifier every mock reply reports unless configured otherwise. */
export const MOCK_MODEL_ID = 'mock/jev-synthetic'

/**
 * A deterministic provider. Given the same requests in the same order it
 * answers identically; it never touches the network.
 */
export class MockJevProvider implements JevProvider {
  readonly kind = 'mock' as const
  readonly #options: MockJevProviderOptions
  readonly #requests: JevProviderRequest<Questions>[] = []
  #calls = 0

  constructor(options: MockJevProviderOptions = {}) {
    this.#options = options
  }

  /** Every request received so far, in call order (test and diagnostic aid). */
  get requests(): readonly JevProviderRequest<Questions>[] {
    return [...this.#requests]
  }

  /** Number of answered/attempted calls. */
  get callCount(): number {
    return this.#calls
  }

  async ask<Q extends Questions>(
    request: JevProviderRequest<Q>,
    options: JevCallOptions = {},
  ): Promise<JevProviderReply<Q>> {
    const callIndex = this.#calls
    this.#calls += 1
    this.#requests.push(request as JevProviderRequest<Questions>)

    const delayMs = this.#options.delayMs ?? 0
    if (delayMs > 0) await sleep(delayMs, options.signal)
    if (options.signal?.aborted) {
      throw new JevError('ABORTED', 'mock request aborted', { retryable: false })
    }

    const scenario = this.#options.scenarioFor?.(request as JevProviderRequest<Questions>, callIndex)
      ?? this.#options.scenario
      ?? {}

    if (scenario.error !== undefined) {
      throw new JevError(scenario.error.code, scenario.error.message ?? 'mock provider failure', {
        retryable: scenario.error.retryable ?? false,
      })
    }

    const answers: Record<string, unknown> = {}
    for (const [questionId, question] of Object.entries(request.questions)) {
      const spec = scenario.answers?.[questionId]
      if (spec?.omit === true) continue
      const answerType = spec?.wrongType ?? question.type
      switch (answerType) {
        case 'choice': {
          const criteria = 'criteria' in question && isStringKeyRecord(question.criteria)
            ? Object.keys(question.criteria)
            : []
          const specChoice = typeof spec?.choice === 'string'
            ? { choice: spec.choice }
            : spec?.choice ?? { choice: criteria[0] ?? '' }
          const confidence = specChoice.confidence ?? 0.9
          answers[questionId] = {
            type: 'choice',
            choice: specChoice.choice,
            confidence,
            probabilities: specChoice.probabilities ?? distribution(criteria, specChoice.choice, confidence),
          }
          break
        }
        case 'score': {
          const levels = 'criteria' in question && Array.isArray(question.criteria) ? question.criteria.length : 2
          const specScore = typeof spec?.score === 'number'
            ? { score: spec.score }
            : spec?.score ?? { score: 0 }
          const confidence = specScore.confidence ?? 1
          answers[questionId] = {
            type: 'score',
            score: specScore.score,
            confidence,
            legend: Object.fromEntries(Array.from({ length: levels }, (_, index) => [String(index), `level ${index}`])),
            probabilities: specScore.probabilities ?? levelDistribution(levels, specScore.score),
          }
          break
        }
        case 'noul': {
          answers[questionId] = { type: 'noul', noul: spec?.noul ?? 0.5 }
          break
        }
      }
    }

    const reply = {
      model: scenario.model ?? this.#options.model ?? MOCK_MODEL_ID,
      answers,
      usage: scenario.usage ?? { input_tokens: 0, output_tokens: 0 },
    }
    return validateReply(request, reply)
  }
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

function isStringKeyRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Deterministic distribution: `confidence` on the chosen label, the rest split evenly. */
function distribution(labels: readonly string[], chosen: string, confidence: number): Record<string, number> {
  if (labels.length === 0) return {}
  if (labels.length === 1) return { [labels[0] as string]: 1 }
  const remainder = (1 - confidence) / (labels.length - 1)
  const probabilities: Record<string, number> = {}
  let sum = 0
  for (const label of labels) {
    const value = round6(label === chosen ? confidence : remainder)
    probabilities[label] = value
    sum += value
  }
  if (chosen in probabilities) {
    probabilities[chosen] = round6((probabilities[chosen] as number) + (1 - sum))
  }
  return probabilities
}

/** Deterministic score distribution: all probability on the nearest level. */
function levelDistribution(levels: number, score: number): Record<string, number> {
  const chosen = Math.max(0, Math.min(levels - 1, Math.round(score)))
  const probabilities: Record<string, number> = {}
  for (let level = 0; level < levels; level += 1) probabilities[String(level)] = level === chosen ? 1 : 0
  return probabilities
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new JevError('ABORTED', 'mock request aborted', { retryable: false }))
    }
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
}
