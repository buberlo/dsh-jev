/**
 * Public vocabulary of the Jev decision core.
 *
 * The core is harness-independent: it knows TypeSafe questions and answers,
 * structured decisions, and nothing about DeepSeek Harness.
 *
 * @module jev-core/types
 */

import type { EntryType, Questions, ResultFor, Usage } from '@typesafe-ai/sdk'
import type { JevErrorCode, JevViolation } from './errors.js'

/** Whether Jev runs at all and whether its decisions are allowed to act. */
export type JevMode = 'off' | 'shadow' | 'enforce'

/** Which provider implementation answers questions. */
export type JevProviderKind = 'mock' | 'live'

/** The deterministic actions a policy may attach to a decision. */
export type DecisionAction = 'allow' | 'ask' | 'hold' | 'deny'

/**
 * One policy decision. `applied` is false in `shadow` mode (and for
 * `off`/`abstain` outcomes), so callers can log the decision without acting.
 */
export interface PolicyDecision {
  readonly action: DecisionAction
  /** Stable rule id, so a decision can be traced without any natural-language explanation. */
  readonly rule: string
  /** Deterministic, human-readable reason built from the rule and the measured values. */
  readonly reason: string
  /** Question id the rule read, when it read one. */
  readonly question?: string
  /** Whether the caller should apply this decision (enforce) or only log it (shadow). */
  readonly applied: boolean
}

/** Validated, typed answers keyed exactly like the questions sent. */
export type ValidatedAnswers<Q extends Questions> = { readonly [K in keyof Q]: ResultFor<Q[K]> }

/** One request to a Jev provider, mirroring the TypeSafe `systemOne` shape. */
export interface JevProviderRequest<Q extends Questions = Questions> {
  readonly state: EntryType
  readonly questions: Q
  readonly model?: string
}

/** One validated provider reply. `answers` is checked against `questions`. */
export interface JevProviderReply<Q extends Questions = Questions> {
  /** Actual model identifier reported by the provider. */
  readonly model: string
  readonly answers: ValidatedAnswers<Q>
  /** Provider-reported usage; zeros when the provider reported none. */
  readonly usage: Usage
}

/** Per-call controls for one provider request. */
export interface JevCallOptions {
  /** Caller-owned cancellation; forwarded to the SDK and combined with the budget. */
  readonly signal?: AbortSignal | undefined
  /** Per-attempt timeout in milliseconds (live provider). */
  readonly timeoutMs?: number | undefined
  /** Whole-call time budget in milliseconds, including SDK-owned retries. */
  readonly budgetMs?: number | undefined
}

/** A source of Jev answers: the live TypeSafe API or a deterministic mock. */
export interface JevProvider {
  readonly kind: JevProviderKind
  ask<Q extends Questions>(
    request: JevProviderRequest<Q>,
    options?: JevCallOptions,
  ): Promise<JevProviderReply<Q>>
}

/** Structured failure data attached to a non-throwing evaluation result. */
export interface JevFailure {
  readonly code: JevErrorCode
  readonly message: string
  readonly retryable: boolean
  readonly violations: readonly JevViolation[]
}

/** Trimmed, non-secret diagnostics of one evaluation. */
export interface EvaluationDiagnostics {
  readonly provider: JevProviderKind
  readonly mode: JevMode
  /** Actual model that answered, when one did. */
  readonly model?: string
  readonly latencyMs: number
  readonly usage?: Usage
  /** Rough size of the transmitted state, in characters (after bounding/redaction). */
  readonly stateChars: number
  /** True when the state was truncated to respect the configured bound. */
  readonly stateTruncated: boolean
  /** Deterministic stage labels executed for this evaluation. */
  readonly stages: readonly string[]
}

/** Result of a generic batched evaluation. */
export type EvaluateResult<Q extends Questions> =
  | {
    readonly ok: true
    readonly answers: ValidatedAnswers<Q>
    readonly decisions: readonly PolicyDecision[]
    readonly diagnostics: EvaluationDiagnostics
  }
  | {
    readonly ok: false
    readonly failure: JevFailure
    readonly decisions: readonly []
    readonly diagnostics: EvaluationDiagnostics
  }

/** Rule kinds available without custom code; all read one typed answer. */
export type DecisionRule =
  | { readonly id: string; readonly kind: 'noul-at-least'; readonly question: string; readonly value: number; readonly action: DecisionAction; readonly reason: string }
  | { readonly id: string; readonly kind: 'noul-below'; readonly question: string; readonly value: number; readonly action: DecisionAction; readonly reason: string }
  | { readonly id: string; readonly kind: 'choice-is'; readonly question: string; readonly label: string; readonly action: DecisionAction; readonly reason: string }
  | { readonly id: string; readonly kind: 'choice-not'; readonly question: string; readonly label: string; readonly action: DecisionAction; readonly reason: string }
  | { readonly id: string; readonly kind: 'confidence-below'; readonly question: string; readonly value: number; readonly action: DecisionAction; readonly reason: string }
  | { readonly id: string; readonly kind: 'score-at-least'; readonly question: string; readonly value: number; readonly action: DecisionAction; readonly reason: string }
