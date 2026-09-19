/**
 * Pre-execution assessment adapter.
 *
 * Runs on the asynchronous `tools/pre-execute` waterfall, never on a
 * synchronous guard. It always delegates first (`next()`), then composes its
 * decision monotonically: a downstream denial is preserved, a Jev ask is
 * added, and a Jev denial wins. Nothing here can turn a denial, a cancellation,
 * or another policy's approval requirement into an allow.
 *
 * @module dsh-jev/adapters/assessment
 */

import type { Context } from '@deepseek-ai/cordis'
import { combineActions } from '@buberlo/jev-core'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { combineSignals } from '@buberlo/jev-core'
import { describeThrown, type JevRuntime } from '../service.js'
import type { ToolAssessment } from '@buberlo/jev-core'

/** Install the `tools/pre-execute` listener. */
export function installAssessmentAdapter(ctx: Context, runtime: JevRuntime): void {
  ctx.on('tools/pre-execute', async (exec: ToolExecution, next): Promise<PreToolDecision> => {
    const downstream = await next()
    if (runtime.mode === 'off' || !runtime.settings.assessment.enabled) return downstream
    if (exec.agent === undefined) return downstream
    if (downstream.kind === 'deny' || downstream.kind === 'cancel') return downstream

    const state = runtime.stateFor(exec.agent)
    if (state === undefined) return downstream
    const snapshotVersion = state.snapshot.version
    const catalogVersion = runtime.catalogVersion

    const controller = new AbortController()
    state.addInFlight(controller)
    let assessment: ToolAssessment
    try {
      assessment = await runtime.assess({
        task: state.snapshot.task,
        step: state.snapshot.step,
        toolId: exec.name,
        arguments: exec.arguments,
        restrictions: runtime.settings.assessment.restrictions,
        includeRiskScore: runtime.settings.assessment.includeRiskScore,
        signal: combineSignals([exec.signal, controller.signal]),
        mode: runtime.mode,
      })
    } catch (error) {
      runtime.log('warn', `assessment failed unexpectedly: ${describeThrown(error)}`)
      return withFailureAction(downstream, runtime, 'unexpected-error')
    } finally {
      state.removeInFlight(controller)
    }

    const stale = state.snapshot.version !== snapshotVersion || runtime.catalogVersion !== catalogVersion
    if (stale) {
      runtime.stats.staleDiscarded += 1
      runtime.log('warn', 'assessment discarded: snapshot or tool catalog changed while evaluating')
      return withFailureAction(downstream, runtime, 'stale')
    }

    runtime.log('info', `tool assessment ${assessment.status}`, {
      tool: exec.name,
      provider: assessment.diagnostics.provider,
      model: assessment.diagnostics.model ?? undefined,
      rule: strongestRule(assessment),
      matchesTask: assessment.values.matchesTask,
      missingInformation: assessment.values.missingInformation,
      violatesRestriction: assessment.values.violatesRestriction,
      latencyMs: Math.round(assessment.diagnostics.latencyMs),
      failure: assessment.failure?.code,
    })

    if (runtime.mode !== 'enforce' || !assessment.applied || assessment.status === 'off') return downstream
    return compose(downstream, assessment.status, assessmentReason(assessment))
  })
}

/** The strictest decision a Jev assessment produced. */
function strongestAction(assessment: ToolAssessment): 'allow' | 'ask' | 'hold' | 'deny' {
  if (assessment.status === 'off') return 'allow'
  return assessment.status
}

function strongestRule(assessment: ToolAssessment): string | undefined {
  const target = strongestAction(assessment)
  return assessment.decisions.find(decision => decision.action === target)?.rule
    ?? assessment.decisions[0]?.rule
}

/**
 * Deterministic model-facing reason: the policy rule id plus the measured
 * values. No model-generated prose is ever used.
 */
function assessmentReason(assessment: ToolAssessment): string {
  const target = strongestAction(assessment)
  const decision = assessment.decisions.find(candidate => candidate.action === target) ?? assessment.decisions[0]
  const rule = decision?.rule ?? 'assessment'
  const measured = decision?.reason ?? ''
  return `[jev] ${target} by ${rule}${measured.length > 0 ? `: ${measured}` : ''}`
}

/** Failure path: the configured ask/hold action, never an allow. */
function withFailureAction(
  downstream: PreToolDecision,
  runtime: JevRuntime,
  reason: string,
): PreToolDecision {
  if (runtime.mode !== 'enforce') return downstream
  const action = runtime.settings.assessment.onFailure
  const text = `[jev] approval required by failure policy (${reason}); no usable assessment`
  return compose(downstream, action, text)
}

/** Compose the Jev action with the downstream decision monotonically. */
function compose(
  downstream: PreToolDecision,
  action: 'allow' | 'ask' | 'hold' | 'deny',
  reason: string,
): PreToolDecision {
  if (downstream.kind === 'deny' || downstream.kind === 'cancel') return downstream
  const effective = combineActions([
    action,
    downstream.kind === 'ask' ? 'ask' : 'allow',
  ])
  switch (effective) {
    case 'deny':
      return { kind: 'deny', reason, info: { name: 'JevAssessment', code: 'JEV_DENIED' } }
    case 'hold':
      // Withheld without a model-facing policy denial; the canonical
      // cancellation result is the supported "do not run" decision.
      return { kind: 'cancel' }
    case 'ask':
      return downstream.kind === 'ask' ? downstream : { kind: 'ask', reason }
    default:
      return downstream
  }
}
