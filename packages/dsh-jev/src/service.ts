/**
 * `ctx.jev` service: owns the decision core, per-agent state, and the
 * deterministic local bookkeeping that does not involve Jev at all.
 *
 * @module dsh-jev/service
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  createJevCore,
  LiveTypeSafeProvider,
  LoopDetector,
  MockJevProvider,
  isJevError,
  type JevCore,
  type JevMode,
  type JevProvider,
  type ToolAssessment,
} from '@buberlo/jev-core'
import { Config as ConfigSchema, resolveSettings, type Config, type ResolvedSettings } from './config.js'
import { installSettingsSection } from './settings-section.js'
import { AgentState } from './state.js'
import { installAssessmentAdapter } from './adapters/assessment.js'
import { installPreStepAdapter } from './adapters/pre-step.js'
import { installObservationAdapter } from './adapters/observation.js'
import { installModelAdapter } from './adapters/model-routing.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    jev: JevRuntime
  }
}

/** Counters for diagnostics; no decision values or argument data are retained. */
export interface JevStats {
  selections: number
  selectionFailures: number
  abstentions: number
  restrictionsApplied: number
  assessments: number
  asks: number
  holds: number
  denials: number
  assessmentFailures: number
  loopDenials: number
  staleDiscarded: number
}

/** Runtime service behind `ctx.jev`. */
export class JevRuntime extends Service {
  static inject = ['tools']

  static Config = ConfigSchema

  private settingsValue: ResolvedSettings
  private coreValue: JevCore
  private readonly entryConfig: Config
  readonly detector: LoopDetector
  readonly stats: JevStats = {
    selections: 0,
    selectionFailures: 0,
    abstentions: 0,
    restrictionsApplied: 0,
    assessments: 0,
    asks: 0,
    holds: 0,
    denials: 0,
    assessmentFailures: 0,
    loopDenials: 0,
    staleDiscarded: 0,
  }

  private states = new Map<Agent, AgentState>()
  private catalogRevision = 0

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'jev')
    this.entryConfig = config
    this.settingsValue = resolveSettings(config)
    this.coreValue = createCore(this.settingsValue)
    this.detector = new LoopDetector({
      maxRepeats: this.settingsValue.loopDetection.maxRepeats,
      maxSubjects: this.settingsValue.loopDetection.maxSubjects,
    })

    ctx.on('tools/change', () => {
      this.catalogRevision += 1
    })
    ctx.on('agent/disposed', ({ agent }) => {
      this.disposeAgent(agent)
    })
    ctx.effect(() => () => {
      for (const agent of [...this.states.keys()]) this.disposeAgent(agent)
      this.core.abortAll(new Error('dsh-jev disposed'))
    }, 'dsh-jev state cleanup')

    installPreStepAdapter(ctx, this)
    installAssessmentAdapter(ctx, this)
    installObservationAdapter(ctx, this)
    installModelAdapter(ctx, this)
    installSettingsSection(ctx, this, this.entryConfig)

    this.log('info', 'loaded', {
      provider: this.settings.provider,
      mode: this.settings.mode,
      selection: this.settings.selection.enabled,
      assessment: this.settings.assessment.enabled,
      loopDetection: this.settings.loopDetection.enabled,
      skills: this.settings.skills.enabled,
      modelRouting: this.settings.modelRouting.enabled,
    })
    if (this.settings.provider === 'live' && this.settings.mode !== 'off') {
      this.log('warn', 'provider "live" transmits task state to TypeSafe — this includes shadow mode (results are logged, not applied)')
    }
  }

  /** Effective behavior mode. */
  get mode(): JevMode {
    return this.settingsValue.mode
  }

  /** Effective settings (replaced by {@link reconfigure}). */
  get settings(): ResolvedSettings {
    return this.settingsValue
  }

  /** The configured decision core (replaced by {@link reconfigure}). */
  get core(): JevCore {
    return this.coreValue
  }

  /**
   * Adopt a new configuration, typically from a committed settings write.
   * The old core is aborted, the provider and core are rebuilt, and every
   * agent's tool-selection restriction is lifted so the next pre-step
   * recomputes from the unrestricted catalog.
   * @param config - the new resolved configuration source.
   */
  reconfigure(config: Config): void {
    const next = resolveSettings(config)
    this.coreValue.abortAll(new Error('dsh-jev reconfigured'))
    this.settingsValue = next
    this.coreValue = createCore(next)
    for (const state of this.states.values()) state.liftSelection()
    this.log('info', 'reconfigured', {
      provider: next.provider,
      mode: next.mode,
      selection: next.selection.enabled,
      assessment: next.assessment.enabled,
    })
    if (next.provider === 'live' && next.mode !== 'off') {
      this.log('warn', 'provider "live" transmits task state to TypeSafe — this includes shadow mode (results are logged, not applied)')
    }
  }

  /** Monotonic tool-catalog revision; advances on every registry change. */
  get catalogVersion(): number {
    return this.catalogRevision
  }

  /** Number of agents with live state. */
  get trackedAgents(): number {
    return this.states.size
  }

  /** Get or create the state for one agent. */
  ensureState(agent: Agent): AgentState {
    let state = this.states.get(agent)
    if (state === undefined) {
      state = new AgentState(agent)
      this.states.set(agent, state)
    }
    return state
  }

  /** Read state without creating it. */
  stateFor(agent: Agent): AgentState | undefined {
    return this.states.get(agent)
  }

  /** Tear down one agent's state: abort requests, lift restrictions, drop counters. */
  disposeAgent(agent: Agent): void {
    const state = this.states.get(agent)
    if (state === undefined) return
    state.dispose()
    this.states.delete(agent)
    this.detector.reset(agent)
  }

  /**
   * Run one assessment through the configured mode. Exposed for tests and
   * adapters; never throws for provider failures.
   */
  async assess(input: Parameters<JevCore['assessToolCall']>[0]): Promise<ToolAssessment> {
    this.stats.assessments += 1
    const assessment = await this.core.assessToolCall(input)
    if (assessment.failure !== undefined) this.stats.assessmentFailures += 1
    if (assessment.applied) {
      if (assessment.status === 'ask') this.stats.asks += 1
      if (assessment.status === 'hold') this.stats.holds += 1
      if (assessment.status === 'deny') this.stats.denials += 1
    }
    return assessment
  }

  /** Structured decision log; never includes raw argument values. */
  log(level: 'debug' | 'info' | 'warn', message: string, data?: Record<string, unknown>): void {
    if (!this.settings.logDecisions && level !== 'warn') return
    const text = `[dsh-jev] ${message}`
    if (level === 'warn') this.ctx.logger.warn(text, data ?? '')
    else if (level === 'debug') this.ctx.logger.debug(text, data ?? '')
    else this.ctx.logger.info(text, data ?? '')
  }
}

function createCore(settings: ResolvedSettings): JevCore {
  return createJevCore({
    provider: createProvider(settings),
    mode: settings.mode,
    ...(settings.model === undefined ? {} : { model: settings.model }),
    thresholds: settings.thresholds,
    limits: {
      budgetMs: settings.budgetMs,
      maxConcurrent: settings.maxConcurrent,
      maxStateChars: settings.maxStateChars,
      maxArgumentChars: settings.maxArgumentChars,
      maxCategories: settings.maxCategories,
      maxCandidatesPerQuestion: settings.maxCandidatesPerQuestion,
      maxSelectedTools: settings.maxSelectedTools,
      maxSkills: settings.maxSkills,
    },
    onFailure: { toolAssessment: settings.assessment.onFailure },
    ...(settings.redactKeys.length === 0 ? {} : { redactKeys: settings.redactKeys }),
  })
}

function createProvider(settings: ResolvedSettings): JevProvider {
  if (settings.provider === 'mock') {
    return new MockJevProvider({
      scenario: { answers: settings.mock.answers },
      delayMs: settings.mock.delayMs,
    })
  }
  if (settings.mode !== 'off' && (settings.apiKey === undefined || settings.apiKey.trim().length === 0)) {
    throw new Error(
      'dsh-jev: provider "live" requires an explicit apiKey (never read from the environment implicitly); '
      + 'set provider to "mock", mode to "off", or pass apiKey explicitly',
    )
  }
  return new LiveTypeSafeProvider({
    apiKey: settings.apiKey ?? '',
    ...(settings.model === undefined ? {} : { model: settings.model }),
    ...(settings.baseURL === undefined ? {} : { baseURL: settings.baseURL }),
    timeoutMs: settings.timeoutMs,
    maxRetries: settings.maxRetries,
  })
}

/** Normalize an unknown thrown value for a bounded log line. */
export function describeThrown(error: unknown): string {
  if (isJevError(error)) return `${error.code}: ${error.message}`
  return error instanceof Error ? error.message : String(error)
}

export default JevRuntime
