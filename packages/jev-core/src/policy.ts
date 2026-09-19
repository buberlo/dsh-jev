/**
 * Deterministic rule evaluation over validated answers.
 *
 * Rules only read measured values; they never invent explanations. Every
 * decision carries the rule id and the values it read, so a caller can trace
 * exactly why an action was chosen.
 *
 * @module jev-core/policy
 */

import type { Question, Questions, ResultFor } from '@typesafe-ai/sdk'
import type { DecisionAction, DecisionRule, PolicyDecision, ValidatedAnswers } from './types.js'

/** Higher wins when decisions are combined; `allow` is the identity. */
export const ACTION_PRECEDENCE: Readonly<Record<DecisionAction, number>> = Object.freeze({
  allow: 0,
  ask: 1,
  hold: 2,
  deny: 3,
})

/**
 * Combine actions monotonically: the strictest action wins. A decision derived
 * from an error can therefore never be softened by a later, weaker one.
 * @param actions - actions to combine.
 * @returns the strictest action, or `allow` for an empty list.
 */
export function combineActions(actions: readonly DecisionAction[]): DecisionAction {
  let selected: DecisionAction = 'allow'
  for (const action of actions) {
    if (ACTION_PRECEDENCE[action] > ACTION_PRECEDENCE[selected]) selected = action
  }
  return selected
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3)
}

/**
 * Evaluate serializable rules against validated answers.
 * @param answers - validated answers keyed like the request.
 * @param rules - rules to test in order.
 * @param applied - whether the caller may act on the results (enforce) or only log them (shadow).
 * @returns one decision per matching rule.
 */
export function applyRules<Q extends Questions>(
  answers: ValidatedAnswers<Q>,
  rules: readonly DecisionRule[],
  applied: boolean,
): PolicyDecision[] {
  const byId = answers as unknown as Record<string, ResultFor<Question>>
  const decisions: PolicyDecision[] = []
  for (const rule of rules) {
    const answer = byId[rule.question]
    if (answer === undefined) continue
    let matched = false
    let measured = ''
    switch (rule.kind) {
      case 'noul-at-least':
        if (answer.type === 'noul') {
          matched = answer.noul >= rule.value
          measured = `noul=${formatNumber(answer.noul)} >= ${formatNumber(rule.value)}`
        }
        break
      case 'noul-below':
        if (answer.type === 'noul') {
          matched = answer.noul < rule.value
          measured = `noul=${formatNumber(answer.noul)} < ${formatNumber(rule.value)}`
        }
        break
      case 'choice-is':
        if (answer.type === 'choice') {
          matched = answer.choice === rule.label
          measured = `choice=${answer.choice}`
        }
        break
      case 'choice-not':
        if (answer.type === 'choice') {
          matched = answer.choice !== rule.label
          measured = `choice=${answer.choice}`
        }
        break
      case 'confidence-below':
        if (answer.type === 'choice' || answer.type === 'score') {
          matched = answer.confidence < rule.value
          measured = `confidence=${formatNumber(answer.confidence)} < ${formatNumber(rule.value)}`
        }
        break
      case 'score-at-least':
        if (answer.type === 'score') {
          matched = answer.score >= rule.value
          measured = `score=${formatNumber(answer.score)} >= ${formatNumber(rule.value)}`
        }
        break
    }
    if (matched) {
      decisions.push({
        action: rule.action,
        rule: rule.id,
        reason: `${rule.reason} (${measured})`,
        question: rule.question,
        applied,
      })
    }
  }
  return decisions
}

/** Turn the configured failure action into the decision a caller applies. */
export function failureDecision(
  action: 'ask' | 'hold' | 'fallback',
  rule: string,
  reason: string,
  applied: boolean,
): PolicyDecision {
  const resolved: DecisionAction = action === 'ask' ? 'ask' : action === 'hold' ? 'hold' : 'allow'
  return { action: resolved, rule, reason, applied }
}
