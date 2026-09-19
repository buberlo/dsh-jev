/**
 * Boundary validation of provider replies.
 *
 * A malformed reply must never become a permissive decision, so every answer
 * is checked against the question that produced it: presence, type, candidate
 * membership, numeric ranges, and distribution shape.
 *
 * @module jev-core/validate
 */

import type { Questions } from '@typesafe-ai/sdk'
import { JevError, type JevViolation } from './errors.js'
import type { JevProviderReply, JevProviderRequest, ValidatedAnswers } from './types.js'

const SUM_TOLERANCE = 1e-3
const MAX_PRINTED = 120

function printable(value: unknown): unknown {
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (typeof value === 'string') return value.length > MAX_PRINTED ? `${value.slice(0, MAX_PRINTED)}…` : value
  if (Array.isArray(value)) return `[array length ${value.length}]`
  if (typeof value === 'object' && value !== null) return `{${Object.keys(value).slice(0, 8).join(', ')}}`
  return String(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUnit(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

/**
 * Validate one raw provider reply against its request.
 * @param request - the questions that were sent.
 * @param reply - the raw reply payload.
 * @returns the typed, structurally validated reply.
 * @throws {JevError} with code `INVALID_RESPONSE` and every collected violation.
 */
export function validateReply<Q extends Questions>(
  request: JevProviderRequest<Q>,
  reply: unknown,
): JevProviderReply<Q> {
  const violations: JevViolation[] = []

  if (!isRecord(reply)) {
    throw new JevError('INVALID_RESPONSE', 'provider reply is not an object', {
      detail: [{ path: '', message: 'expected an object', received: printable(reply) }],
    })
  }

  const model = reply.model
  if (typeof model !== 'string' || model.length === 0) {
    violations.push({ path: 'model', message: 'expected a non-empty model identifier', received: printable(model) })
  }

  const rawAnswers = reply.answers
  if (!isRecord(rawAnswers)) {
    violations.push({ path: 'answers', message: 'expected an object keyed by question id', received: printable(rawAnswers) })
    throw new JevError('INVALID_RESPONSE', 'provider reply has no usable answers object', { detail: violations })
  }

  const answers: Record<string, unknown> = {}
  for (const [questionId, question] of Object.entries(request.questions)) {
    const answer = rawAnswers[questionId]
    const path = `answers.${questionId}`
    if (answer === undefined) {
      violations.push({ path, message: 'missing answer for a sent question' })
      continue
    }
    if (!isRecord(answer)) {
      violations.push({ path, message: 'expected an answer object', received: printable(answer) })
      continue
    }
    if (answer.type !== question.type) {
      violations.push({
        path: `${path}.type`,
        message: `answer type must match the question type "${question.type}"`,
        received: printable(answer.type),
      })
      continue
    }
    switch (question.type) {
      case 'choice':
        answers[questionId] = validateChoiceAnswer(path, question.criteria, answer, violations)
        break
      case 'score':
        answers[questionId] = validateScoreAnswer(path, question.criteria.length, answer, violations)
        break
      case 'noul':
        answers[questionId] = validateNoulAnswer(path, answer, violations)
        break
    }
  }

  for (const extra of Object.keys(rawAnswers)) {
    if (!(extra in request.questions)) {
      violations.push({ path: `answers.${extra}`, message: 'unexpected answer for a question that was never sent' })
    }
  }

  const usage = validateUsage(reply.usage, violations)

  if (violations.length > 0) {
    throw new JevError('INVALID_RESPONSE', `provider reply failed validation (${violations.length} violation(s))`, {
      detail: violations,
    })
  }

  return {
    model: model as string,
    answers: answers as ValidatedAnswers<Q>,
    usage,
  }
}

function validateChoiceAnswer(
  path: string,
  criteria: Record<string, unknown>,
  answer: Record<string, unknown>,
  violations: JevViolation[],
): { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> } {
  const candidates = Object.keys(criteria)
  const choice = answer.choice
  if (typeof choice !== 'string' || !candidates.includes(choice)) {
    violations.push({
      path: `${path}.choice`,
      message: `expected one of the sent candidates [${candidates.join(', ')}]`,
      received: printable(choice),
    })
  }
  const confidence = answer.confidence
  if (!isUnit(confidence)) {
    violations.push({ path: `${path}.confidence`, message: 'expected a finite number in [0, 1]', received: printable(confidence) })
  }
  const probabilities = answer.probabilities
  if (!isRecord(probabilities)) {
    violations.push({ path: `${path}.probabilities`, message: 'expected a distribution object', received: printable(probabilities) })
  } else {
    let sum = 0
    let sawAny = false
    for (const candidate of candidates) {
      const value = probabilities[candidate]
      if (!isUnit(value)) {
        violations.push({
          path: `${path}.probabilities.${candidate}`,
          message: 'expected a finite number in [0, 1] for every sent candidate',
          received: printable(value),
        })
      } else {
        sum += value
        sawAny = true
      }
    }
    for (const extra of Object.keys(probabilities)) {
      if (!candidates.includes(extra)) {
        violations.push({ path: `${path}.probabilities.${extra}`, message: 'probability for an unknown candidate' })
      }
    }
    if (sawAny && Math.abs(sum - 1) > SUM_TOLERANCE) {
      violations.push({ path: `${path}.probabilities`, message: `distribution must sum to 1 (±${SUM_TOLERANCE})`, received: sum })
    }
  }
  return {
    type: 'choice',
    choice: typeof choice === 'string' ? choice : '',
    confidence: typeof confidence === 'number' ? confidence : 0,
    probabilities: isRecord(probabilities) ? probabilities as Record<string, number> : {},
  }
}

function validateScoreAnswer(
  path: string,
  levelCount: number,
  answer: Record<string, unknown>,
  violations: JevViolation[],
): { type: 'score'; score: number; confidence: number; legend: Record<string, unknown>; probabilities: Record<string, number> } {
  const top = levelCount - 1
  const numeric = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
  const score = answer.score
  if (!numeric(score) || score < 0 || score > top) {
    violations.push({ path: `${path}.score`, message: `expected a finite number in [0, ${top}]`, received: printable(score) })
  }
  const confidence = answer.confidence
  if (!isUnit(confidence)) {
    violations.push({ path: `${path}.confidence`, message: 'expected a finite number in [0, 1]', received: printable(confidence) })
  }
  const probabilities = answer.probabilities
  if (!isRecord(probabilities)) {
    violations.push({ path: `${path}.probabilities`, message: 'expected a level distribution object', received: printable(probabilities) })
  } else {
    let sum = 0
    for (let level = 0; level < levelCount; level += 1) {
      const value = probabilities[String(level)]
      if (!isUnit(value)) {
        violations.push({
          path: `${path}.probabilities.${level}`,
          message: 'expected a finite number in [0, 1] for every sent level',
          received: printable(value),
        })
      } else {
        sum += value
      }
    }
    for (const extra of Object.keys(probabilities)) {
      const index = Number(extra)
      if (!Number.isInteger(index) || index < 0 || index >= levelCount) {
        violations.push({ path: `${path}.probabilities.${extra}`, message: 'probability for an unknown level' })
      }
    }
    if (Math.abs(sum - 1) > SUM_TOLERANCE) {
      violations.push({ path: `${path}.probabilities`, message: `distribution must sum to 1 (±${SUM_TOLERANCE})`, received: sum })
    }
  }
  const legend = answer.legend
  if (legend !== undefined && !isRecord(legend)) {
    violations.push({ path: `${path}.legend`, message: 'expected a level-keyed legend object', received: printable(legend) })
  }
  return {
    type: 'score',
    score: typeof score === 'number' ? score : 0,
    confidence: typeof confidence === 'number' ? confidence : 0,
    legend: isRecord(legend) ? legend : {},
    probabilities: isRecord(probabilities) ? probabilities as Record<string, number> : {},
  }
}

function validateNoulAnswer(
  path: string,
  answer: Record<string, unknown>,
  violations: JevViolation[],
): { type: 'noul'; noul: number } {
  const noul = answer.noul
  if (!isUnit(noul)) {
    violations.push({ path: `${path}.noul`, message: 'expected a finite number in [0, 1]', received: printable(noul) })
  }
  // Noul has no confidence value. Any extra field is dropped so downstream code
  // can never read a made-up confidence off a noul answer.
  return { type: 'noul', noul: typeof noul === 'number' ? noul : 0 }
}

function validateUsage(usage: unknown, violations: JevViolation[]): { input_tokens: number; output_tokens: number } {
  if (usage === undefined || usage === null) return { input_tokens: 0, output_tokens: 0 }
  if (!isRecord(usage)) {
    violations.push({ path: 'usage', message: 'expected a usage object or none', received: printable(usage) })
    return { input_tokens: 0, output_tokens: 0 }
  }
  const input = usage.input_tokens
  const output = usage.output_tokens
  if (typeof input !== 'number' || !Number.isFinite(input) || input < 0) {
    violations.push({ path: 'usage.input_tokens', message: 'expected a non-negative number', received: printable(input) })
  }
  if (typeof output !== 'number' || !Number.isFinite(output) || output < 0) {
    violations.push({ path: 'usage.output_tokens', message: 'expected a non-negative number', received: printable(output) })
  }
  return {
    input_tokens: typeof input === 'number' && Number.isFinite(input) ? input : 0,
    output_tokens: typeof output === 'number' && Number.isFinite(output) ? output : 0,
  }
}
