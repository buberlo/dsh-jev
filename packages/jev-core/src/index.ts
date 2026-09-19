/**
 * `@buberlo/jev-core` — a harness-independent decision layer built on TypeSafe
 * Jev (System One).
 *
 * Responsibilities are split:
 * - **Provider** executes a Jev request and returns validated model answers
 *   ({@link MockJevProvider}, {@link LiveTypeSafeProvider}).
 * - **Policy** derives decisions from answers, configuration, and trusted
 *   facts ({@link applyRules}, {@link JevCore.assessToolCall}).
 * - **Adapter** (in `@buberlo/dsh-jev` or any other consumer) translates a
 *   decision into supported behavior.
 *
 * @module @buberlo/jev-core
 */

export {
  JevError,
  isJevError,
  describeError,
  type JevErrorCode,
  type JevViolation,
} from './errors.js'

export type {
  DecisionAction,
  DecisionRule,
  EvaluateResult,
  EvaluationDiagnostics,
  JevCallOptions,
  JevFailure,
  JevMode,
  JevProvider,
  JevProviderKind,
  JevProviderReply,
  JevProviderRequest,
  PolicyDecision,
  ValidatedAnswers,
} from './types.js'

export {
  createJevCoreConfig,
  DEFAULT_FAILURE_POLICY,
  DEFAULT_LIMITS,
  DEFAULT_THRESHOLDS,
  type JevCoreConfig,
  type JevCoreConfigInput,
  type JevFailurePolicy,
  type JevLimits,
  type JevThresholds,
} from './config.js'

export { createJevCore, JevCore, type DynamicAnswer, type EvaluateInput } from './core.js'
export { applyRules, combineActions, failureDecision, ACTION_PRECEDENCE } from './policy.js'
export { validateReply } from './validate.js'

export {
  MOCK_MODEL_ID,
  MockJevProvider,
  type MockAnswerSpec,
  type MockChoiceAnswer,
  type MockJevProviderOptions,
  type MockScenario,
  type MockScoreAnswer,
} from './mock-provider.js'

export {
  DEFAULT_LIVE_MODEL,
  LiveTypeSafeProvider,
  mapTypeSafeError,
  type LiveTypeSafeProviderConfig,
} from './live-provider.js'

export {
  choice,
  noul,
  score,
  type ChoiceCriteria,
  type ChoiceQuestion,
  type ChoiceResponse,
  type Description,
  type EntryType,
  type NoulQuestion,
  type NoulResponse,
  type Question,
  type Questions,
  type ResultFor,
  type ScoreCriteria,
  type ScoreLegend,
  type ScoreQuestion,
  type ScoreResponse,
  type SystemOneResult,
  type Usage,
} from './primitives.js'

export {
  chunk,
  selectTools,
  selectionSignature,
  type CategoryOutcome,
  type SelectionDiagnostics,
  type ToolCandidateInfo,
  type ToolCategoryInfo,
  type ToolSelectionInput,
  type ToolSelectionPlan,
} from './selection.js'

export {
  assessToolCall,
  type AssessmentDiagnostics,
  type ToolAssessment,
  type ToolAssessmentValues,
  type ToolCallAssessmentInput,
} from './assessment.js'

export {
  modelTargetKey,
  routeModel,
  routeSkills,
  type ModelRoutingInput,
  type ModelRoutingResult,
  type ModelRoutes,
  type ModelTarget,
  type SkillCandidateInfo,
  type SkillRoutingInput,
  type SkillRoutingResult,
} from './routing.js'

export { LoopDetector, type LoopDetectorOptions, type LoopObservation } from './loop-detector.js'

export {
  boundValue,
  DEFAULT_REDACT_KEYS,
  hashString,
  isSensitiveKey,
  stableStringify,
  type BoundOptions,
} from './redact.js'

export { combineSignals, Semaphore, withBudget, type BudgetSignal } from './limits.js'
