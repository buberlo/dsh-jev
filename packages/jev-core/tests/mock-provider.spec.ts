import { describe, expect, it } from 'vitest'
import { JevError } from '../src/errors.js'
import { MockJevProvider, MOCK_MODEL_ID } from '../src/mock-provider.js'
import { choice, noul, score } from '../src/primitives.js'

describe('MockJevProvider', () => {
  it('is deterministic across identical calls', async () => {
    const provider = new MockJevProvider({
      scenario: {
        answers: {
          department: { choice: { choice: 'billing', confidence: 0.8 } },
          severity: { score: { score: 1, confidence: 0.75 } },
          escalate: { noul: 0.25 },
        },
      },
    })
    const questions = {
      department: choice('Which team?', { billing: 'B', technical: 'T', other: 'O' }),
      severity: score('How severe?', ['low', 'medium', 'high']),
      escalate: noul('Escalate?'),
    }
    const first = await provider.ask({ state: 'ticket', questions })
    const second = await provider.ask({ state: 'ticket', questions })
    expect(first).toEqual(second)
    expect(first.model).toBe(MOCK_MODEL_ID)
    expect(first.answers.department.probabilities).toEqual({ billing: 0.8, technical: 0.1, other: 0.1 })
    expect(first.answers.severity.probabilities).toEqual({ '0': 0, '1': 1, '2': 0 })
    expect(first.answers.severity.confidence).toBe(0.75)
    expect(first.answers.escalate).toEqual({ type: 'noul', noul: 0.25 })
  })

  it('produces valid distributions from a confidence value', async () => {
    const provider = new MockJevProvider({
      scenario: { answers: { pick: { choice: { choice: 'b', confidence: 0.7 } } } },
    })
    const reply = await provider.ask({
      state: 's',
      questions: { pick: choice('Pick', { a: 'A', b: 'B', c: 'C' }) },
    })
    const probabilities = reply.answers.pick.probabilities
    const sum = Object.values(probabilities).reduce((total, value) => total + value, 0)
    expect(sum).toBeCloseTo(1, 6)
  })

  it('surfaces an unknown candidate as an INVALID_RESPONSE failure', async () => {
    const provider = new MockJevProvider({ scenario: { answers: { pick: { choice: 'ghost' } } } })
    await expect(provider.ask({
      state: 's',
      questions: { pick: choice('Pick', { a: 'A' }) },
    })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('can omit an answer to simulate an incomplete reply', async () => {
    const provider = new MockJevProvider({ scenario: { answers: { escalate: { omit: true } } } })
    await expect(provider.ask({
      state: 's',
      questions: { escalate: noul('Escalate?') },
    })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('can emit a wrong answer type', async () => {
    const provider = new MockJevProvider({ scenario: { answers: { escalate: { wrongType: 'choice', choice: 'a' } } } })
    await expect(provider.ask({
      state: 's',
      questions: { escalate: noul('Escalate?') },
    })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('injects configured failures', async () => {
    const provider = new MockJevProvider({ scenario: { error: { code: 'RATE_LIMIT', retryable: true } } })
    const error = await provider.ask({ state: 's', questions: { q: noul('Q?') } }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(JevError)
    expect((error as JevError).code).toBe('RATE_LIMIT')
    expect((error as JevError).retryable).toBe(true)
  })

  it('honours cancellation during the artificial delay', async () => {
    const provider = new MockJevProvider({ delayMs: 1000 })
    const controller = new AbortController()
    const pending = provider.ask({ state: 's', questions: { q: noul('Q?') } }, { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('records the exact requests it received', async () => {
    const provider = new MockJevProvider()
    await provider.ask({ state: 'first', questions: { q: noul('Q?') } })
    await provider.ask({ state: 'second', questions: { q: noul('Q?') } })
    expect(provider.requests.map(request => request.state)).toEqual(['first', 'second'])
    expect(provider.callCount).toBe(2)
  })
})
