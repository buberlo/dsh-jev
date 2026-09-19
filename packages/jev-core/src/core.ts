/**
 * The Jev decision core: one configured object that owns the provider, the
 * bounds, and the policy vocabulary. It imports nothing from any agent
 * harness, so it can be embedded in games, search, or MCP routers as well as
 * in DeepSeek Harness.
 *
 * @module jev-core/core
 */

import type { EntryType, Questions } from '@typesafe-ai/sdk'
import { createJevCoreConfig, type JevCoreConfig, type JevCoreConfigInput } from './config.js'
import { describeError, isJevError, JevError, type JevViolation } from './errors.js'
import { combineSignals, Semaphore, withBudget } from './limits.js'
import { applyRules } from './policy.js'
import { boundValue, type BoundOptions } from './redact.js'
import type {
  DecisionRule,
  EvaluateResult,
  JevFailure,
  JevMode,
  ValidatedAnswers,
} from './types.js'
import { assessToolCall, type ToolAssessment, type ToolCallAssessmentInput } from './assessment.js'
import { selectTools, type ToolSelectionInput, type ToolSelectionPlan } from './selection.js'
import { routeModel, routeSkills, type ModelRoutingInput, type ModelRoutingResult, type SkillRoutingInput, type SkillRoutingResult } from './routing.js'

/** One generic evaluation request. */
export interface EvaluateInput<Q extends Questions> {
  readonly state: EntryType
  readonly questions: Q
  /** Serializable rules to evaluate over the validated answers. */
  readonly rules?: readonly DecisionRule[]
  /** Caller cancellation. */
  readonly signal?: AbortSignal | undefined
  /** Per-call mode override; defaults to the configured mode. */
  readonly mode?: JevMode
}

/** Answer union returned for dynamically built question maps. */
export type DynamicAnswer = ValidatedAnswers<Questions>[keyof Questions]

/**
 * The decision core. Create one per deployment and share it: it owns the
 * concurrency limiter and the in-flight request registry.
 */
export class JevCore {
  readonly config: JevCoreConfig
  readonly #semaphore: Semaphore
  readonly #inFlight = new Set<AbortController>()

  constructor(input: JevCoreConfigInput) {
    this.config = createJevCoreConfig(input)
    this.#semaphore = new Semaphore(this.config.limits.maxConcurrent)
  }

  /** Number of provider requests currently awaiting a reply. */
  get activeRequests(): number {
    return this.#inFlight.size
  }

  /** Whether the supplied redact/bound options use this core's configured limits. */
  get boundOptions(): BoundOptions {
    return {
      maxStringChars: this.config.limits.maxArgumentChars,
      maxArrayItems: this.config.limits.maxArrayItems,
      maxDepth: this.config.limits.maxDepth,
      redactKeys: this.config.redactKeys,
    }
  }

  /**
   * Evaluate a batch of independent questions. Questions within one batch must
   * not depend on each other's answers: build every question the code might
   * need now and ignore the answers it does not use.
   *
   * Never throws for provider or validation failures; those come back as an
   * `ok: false` result so policy code stays total. Programming errors
   * (invalid config) throw at construction time.
   * @param input - state, questions, optional rules, cancellation, mode.
   * @returns a validated result or a structured failure.
   */
  async evaluate<Q extends Questions>(input: EvaluateInput<Q>): Promise<EvaluateResult<Q>> {
    const mode = input.mode ?? this.config.mode
    const stages: string[] = []
    const startedAt = now()
    const bounded = this.#boundState(input.state)
    const diagnosticsBase = {
      provider: this.config.provider.kind,
      mode,
      latencyMs: 0,
      stateChars: bounded.chars,
      stateTruncated: bounded.truncated,
      stages,
    } as const

    if (mode === 'off') {
      return {
        ok: false,
        failure: { code: 'OFF', message: 'mode is off: no evaluation was performed', retryable: false, violations: [] },
        decisions: [],
        diagnostics: { ...diagnosticsBase, latencyMs: now() - startedAt },
      }
    }
    stages.push('provider')

    const release = await this.#semaphore.acquire()
    const controller = new AbortController()
    const combined = combineSignals([input.signal, controller.signal])
    const budget = withBudget(combined, this.config.limits.budgetMs)
    this.#inFlight.add(controller)
    try {
      const reply = await this.config.provider.ask(
        {
          state: bounded.state,
          questions: input.questions,
          ...(this.config.model === undefined ? {} : { model: this.config.model }),
        },
        { signal: budget.signal, timeoutMs: this.config.limits.budgetMs, budgetMs: this.config.limits.budgetMs },
      )
      const applied = mode === 'enforce'
      const decisions = applyRules(reply.answers, input.rules ?? [], applied)
      return {
        ok: true,
        answers: reply.answers,
        decisions,
        diagnostics: {
          ...diagnosticsBase,
          model: reply.model,
          usage: reply.usage,
          latencyMs: now() - startedAt,
        },
      }
    } catch (error) {
      const failure = this.#classifyFailure(error, input.signal, budget.expired())
      return {
        ok: false,
        failure,
        decisions: [],
        diagnostics: { ...diagnosticsBase, latencyMs: now() - startedAt },
      }
    } finally {
      budget.dispose()
      this.#inFlight.delete(controller)
      release()
    }
  }

  /** Tool selection: choose the relevant tools for one task. */
  async selectTools(input: ToolSelectionInput): Promise<ToolSelectionPlan> {
    return selectTools(this, input)
  }

  /** Tool-call assessment: evaluate one concrete call before execution. */
  async assessToolCall(input: ToolCallAssessmentInput): Promise<ToolAssessment> {
    return assessToolCall(this, input)
  }

  /** Skill routing: choose at most one relevant skill from metadata. */
  async routeSkills(input: SkillRoutingInput): Promise<SkillRoutingResult> {
    return routeSkills(this, input)
  }

  /** Model routing: choose a configured route and resolve it to a real target. */
  async routeModel(input: ModelRoutingInput): Promise<ModelRoutingResult> {
    return routeModel(this, input)
  }

  /** Abort every in-flight provider request (disposal path). */
  abortAll(reason?: unknown): void {
    for (const controller of this.#inFlight) controller.abort(reason)
    this.#inFlight.clear()
  }

  #boundState(state: EntryType): { state: EntryType; chars: number; truncated: boolean } {
    if (state === null) return { state: null, chars: 0, truncated: false }
    if (typeof state === 'string') {
      const max = this.config.limits.maxStateChars
      if (state.length <= max) return { state, chars: state.length, truncated: false }
      return { state: `${state.slice(0, max)}…[state truncated]`, chars: max, truncated: true }
    }
    const bounded = boundValue(state, {
      maxStringChars: this.config.limits.maxStateChars,
      maxArrayItems: this.config.limits.maxArrayItems,
      maxDepth: this.config.limits.maxDepth,
      redactKeys: this.config.redactKeys,
    })
    const serialized = JSON.stringify(bounded) ?? ''
    const max = this.config.limits.maxStateChars * 2
    const truncated = serialized.length > max
    return {
      state: bounded as EntryType,
      chars: Math.min(serialized.length, max),
      truncated,
    }
  }

  #classifyFailure(error: unknown, callerSignal: AbortSignal | undefined, budgetExpired: boolean): JevFailure {
    if (isJevError(error)) {
      if (error.code === 'ABORTED' && budgetExpired && callerSignal?.aborted !== true) {
        return { code: 'TIMEOUT', message: 'jev budget elapsed before the provider replied', retryable: true, violations: [] }
      }
      return { code: error.code, message: error.message, retryable: error.retryable, violations: error.detail }
    }
    const violations: readonly JevViolation[] = []
    return { code: 'UNKNOWN', message: describeError(error), retryable: false, violations }
  }
}

/**
 * Create a decision core from partial configuration.
 * @param input - provider plus optional overrides.
 * @returns the configured core.
 */
export function createJevCore(input: JevCoreConfigInput): JevCore {
  return new JevCore(input)
}

/** Monotonic-enough wall clock for latency diagnostics. */
function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

/** Re-exported so callers can construct a valid-failure result in tests. */
export { JevError }
