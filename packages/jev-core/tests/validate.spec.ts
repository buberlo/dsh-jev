import { describe, expect, it } from 'vitest'
import { choice, noul, score } from '../src/primitives.js'
import { JevError } from '../src/errors.js'
import { validateReply } from '../src/validate.js'

const questions = {
  department: choice('Which team?', { billing: 'Billing', technical: 'Technical' }),
  severity: score('How severe?', ['low', 'medium', 'high']),
  escalate: noul('Escalate?'),
}

describe('validateReply', () => {
  it('accepts a complete, well-formed reply', () => {
    const reply = validateReply({ state: 'x', questions }, {
      model: 'jev-1.13.0',
      answers: {
        department: { type: 'choice', choice: 'billing', confidence: 0.9, probabilities: { billing: 0.9, technical: 0.1 } },
        severity: { type: 'score', score: 1.2, confidence: 0.5, legend: { '0': 'low', '1': 'medium', '2': 'high' }, probabilities: { '0': 0, '1': 0.8, '2': 0.2 } },
        escalate: { type: 'noul', noul: 0.7 },
      },
      usage: { input_tokens: 10, output_tokens: 4 },
    })
    expect(reply.model).toBe('jev-1.13.0')
    expect(reply.answers.department.choice).toBe('billing')
    expect(reply.answers.severity.score).toBe(1.2)
    expect(reply.answers.escalate.noul).toBe(0.7)
    expect(reply.usage.input_tokens).toBe(10)
  })

  it('drops any imagined confidence from a noul answer', () => {
    const reply = validateReply({ state: 'x', questions: { escalate: noul('Escalate?') } }, {
      model: 'jev-1.13.0',
      answers: { escalate: { type: 'noul', noul: 0.4, confidence: 0.99 } },
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    expect(reply.answers.escalate).toEqual({ type: 'noul', noul: 0.4 })
    expect('confidence' in reply.answers.escalate).toBe(false)
  })

  it.each([
    ['missing answer', { answers: { severity: { type: 'score', score: 1, confidence: 1, legend: {}, probabilities: { '0': 0, '1': 1, '2': 0 } }, escalate: { type: 'noul', noul: 0.5 } } }],
    ['unknown candidate', { answers: { department: { type: 'choice', choice: 'sales', confidence: 1, probabilities: { billing: 0, technical: 0, sales: 1 } }, severity: { type: 'score', score: 1, confidence: 1, legend: {}, probabilities: { '0': 0, '1': 1, '2': 0 } }, escalate: { type: 'noul', noul: 0.5 } } }],
    ['wrong answer type', { answers: { department: { type: 'noul', noul: 0.5 }, severity: { type: 'score', score: 1, confidence: 1, legend: {}, probabilities: { '0': 0, '1': 1, '2': 0 } }, escalate: { type: 'noul', noul: 0.5 } } }],
    ['distribution does not sum to one', { answers: { department: { type: 'choice', choice: 'billing', confidence: 1, probabilities: { billing: 0.2, technical: 0.2 } }, severity: { type: 'score', score: 1, confidence: 1, legend: {}, probabilities: { '0': 0, '1': 1, '2': 0 } }, escalate: { type: 'noul', noul: 0.5 } } }],
    ['out-of-range probability', { answers: { department: { type: 'choice', choice: 'billing', confidence: 1, probabilities: { billing: 1.4, technical: -0.4 } }, severity: { type: 'score', score: 1, confidence: 1, legend: {}, probabilities: { '0': 0, '1': 1, '2': 0 } }, escalate: { type: 'noul', noul: 0.5 } } }],
    ['score outside the rubric', { answers: { department: { type: 'choice', choice: 'billing', confidence: 1, probabilities: { billing: 1, technical: 0 } }, severity: { type: 'score', score: 7, confidence: 1, legend: {}, probabilities: { '0': 0, '1': 1, '2': 0 } }, escalate: { type: 'noul', noul: 0.5 } } }],
    ['unknown level key', { answers: { department: { type: 'choice', choice: 'billing', confidence: 1, probabilities: { billing: 1, technical: 0 } }, severity: { type: 'score', score: 1, confidence: 1, legend: {}, probabilities: { '0': 0, '1': 1, '2': 0, '9': 0 } }, escalate: { type: 'noul', noul: 0.5 } } }],
    ['invalid confidence', { answers: { department: { type: 'choice', choice: 'billing', confidence: 1.2, probabilities: { billing: 1, technical: 0 } }, severity: { type: 'score', score: 1, confidence: 1, legend: {}, probabilities: { '0': 0, '1': 1, '2': 0 } }, escalate: { type: 'noul', noul: 0.5 } } }],
    ['noul out of range', { answers: { department: { type: 'choice', choice: 'billing', confidence: 1, probabilities: { billing: 1, technical: 0 } }, severity: { type: 'score', score: 1, confidence: 1, legend: {}, probabilities: { '0': 0, '1': 1, '2': 0 } }, escalate: { type: 'noul', noul: 2 } } }],
    ['unexpected extra answer', { answers: { department: { type: 'choice', choice: 'billing', confidence: 1, probabilities: { billing: 1, technical: 0 } }, severity: { type: 'score', score: 1, confidence: 1, legend: {}, probabilities: { '0': 0, '1': 1, '2': 0 } }, escalate: { type: 'noul', noul: 0.5 }, ghost: { type: 'noul', noul: 1 } } }],
  ])('rejects %s', (_label, payload) => {
    let caught: unknown
    try {
      validateReply({ state: 'x', questions }, { model: 'jev-1.13.0', usage: { input_tokens: 1, output_tokens: 1 }, ...payload })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(JevError)
    expect((caught as JevError).code).toBe('INVALID_RESPONSE')
    expect((caught as JevError).detail.length).toBeGreaterThan(0)
  })

  it('rejects a reply without a model identifier', () => {
    expect(() => validateReply({ state: 'x', questions }, { answers: {}, usage: undefined })).toThrowError(JevError)
  })
})
