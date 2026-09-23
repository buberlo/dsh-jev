import { describe, expect, it } from 'vitest'
import { createJevCore, type JevCore } from '../src/core.js'
import { MockJevProvider, type MockAnswerSpec, type MockScenario } from '../src/mock-provider.js'

interface AssessmentSpec {
  matches?: number
  missing?: number
  violates?: number
  risk?: { score: number; confidence: number }
  error?: { code: 'CONNECTION' | 'TIMEOUT' | 'RATE_LIMIT'; retryable?: boolean }
}

function assessmentProvider(spec: AssessmentSpec): MockJevProvider {
  return new MockJevProvider({
    scenarioFor: (request): MockScenario => {
      if (spec.error !== undefined) return { error: { code: spec.error.code, retryable: spec.error.retryable ?? true } }
      const answers: Record<string, MockAnswerSpec> = {}
      for (const questionId of Object.keys(request.questions)) {
        if (questionId === 'matches_task') answers[questionId] = { noul: spec.matches ?? 0.95 }
        else if (questionId === 'missing_information') answers[questionId] = { noul: spec.missing ?? 0.05 }
        else if (questionId === 'violates_restriction') answers[questionId] = { noul: spec.violates ?? 0.05 }
        else if (questionId === 'risk') answers[questionId] = { score: { score: spec.risk?.score ?? 0, confidence: spec.risk?.confidence ?? 1 } }
      }
      return { answers }
    },
  })
}

function coreWith(provider: MockJevProvider, mode: 'off' | 'shadow' | 'enforce', onFailure?: 'ask' | 'hold'): JevCore {
  return createJevCore({ provider, mode, ...(onFailure === undefined ? {} : { onFailure: { toolAssessment: onFailure } }) })
}

const baseInput = {
  task: 'Fix the failing test in the billing module.',
  step: 'Inspect the failing test file',
  toolId: 'read_file',
  arguments: { path: '/repo/src/billing.test.ts' },
  restrictions: ['do not modify files outside /repo'],
}

describe('assessToolCall', () => {
  it('allows a matching call with no missing information and no restriction conflict', async () => {
    const core = coreWith(assessmentProvider({}), 'enforce')
    const assessment = await core.assessToolCall(baseInput)
    expect(assessment.status).toBe('allow')
    expect(assessment.applied).toBe(true)
    expect(assessment.values.matchesTask).toBe(0.95)
    expect(assessment.values.missingInformation).toBe(0.05)
    expect(assessment.values.violatesRestriction).toBe(0.05)
  })

  it('asks when required information is missing', async () => {
    const core = coreWith(assessmentProvider({ missing: 0.9, matches: 0.9 }), 'enforce')
    const assessment = await core.assessToolCall(baseInput)
    expect(assessment.status).toBe('ask')
    expect(assessment.decisions[0]?.rule).toBe('assessment.missing-information')
  })

  it('asks when the call does not match the task', async () => {
    const core = coreWith(assessmentProvider({ matches: 0.1 }), 'enforce')
    const assessment = await core.assessToolCall(baseInput)
    expect(assessment.status).toBe('ask')
    expect(assessment.decisions[0]?.rule).toBe('assessment.task-mismatch')
  })

  it('denies a call that contradicts an explicit restriction', async () => {
    const core = coreWith(assessmentProvider({ violates: 0.95 }), 'enforce')
    const assessment = await core.assessToolCall(baseInput)
    expect(assessment.status).toBe('deny')
    expect(assessment.decisions[0]?.rule).toBe('assessment.restriction-violation')
  })

  it('never softens a denial with a weaker ask', async () => {
    const core = coreWith(assessmentProvider({ violates: 0.95, missing: 0.95, matches: 0.1 }), 'enforce')
    const assessment = await core.assessToolCall(baseInput)
    expect(assessment.status).toBe('deny')
  })

  it('binds the assessment to the exact arguments', async () => {
    const core = coreWith(assessmentProvider({}), 'enforce')
    const first = await core.assessToolCall(baseInput)
    const second = await core.assessToolCall({ ...baseInput, arguments: { path: '/repo/src/other.test.ts' } })
    expect(first.diagnostics.signature).not.toBe(second.diagnostics.signature)
  })

  it('redacts sensitive argument fields before transmission', async () => {
    const provider = assessmentProvider({})
    const core = coreWith(provider, 'enforce')
    await core.assessToolCall({
      ...baseInput,
      arguments: { path: '/repo/x', apiKey: 'sk-live-secret', nested: { password: 'hunter2' } },
    })
    const sent = JSON.stringify(provider.requests)
    expect(sent).not.toContain('sk-live-secret')
    expect(sent).not.toContain('hunter2')
    expect(sent).toContain('[redacted]')
  })

  it('falls back to the configured failure action, never to allow', async () => {
    const askCore = coreWith(assessmentProvider({ error: { code: 'CONNECTION' } }), 'enforce', 'ask')
    const asked = await askCore.assessToolCall(baseInput)
    expect(asked.status).toBe('ask')
    expect(asked.failure?.code).toBe('CONNECTION')

    const holdCore = coreWith(assessmentProvider({ error: { code: 'TIMEOUT' } }), 'enforce', 'hold')
    const held = await holdCore.assessToolCall(baseInput)
    expect(held.status).toBe('hold')
  })

  it('does not apply decisions in shadow mode', async () => {
    const core = coreWith(assessmentProvider({ violates: 0.95 }), 'shadow')
    const assessment = await core.assessToolCall(baseInput)
    expect(assessment.status).toBe('deny')
    expect(assessment.applied).toBe(false)
  })

  it('makes no provider call in off mode and stays unapplied', async () => {
    const provider = assessmentProvider({})
    const core = coreWith(provider, 'off')
    const assessment = await core.assessToolCall(baseInput)
    expect(assessment.status).toBe('off')
    expect(assessment.applied).toBe(false)
    expect(provider.callCount).toBe(0)
  })

  it('includes an ordinal risk score only when requested, without collapsing it into probabilities', async () => {
    const provider = assessmentProvider({ risk: { score: 1.4, confidence: 0.6 } })
    const core = coreWith(provider, 'enforce')
    const withoutRisk = await core.assessToolCall(baseInput)
    expect(withoutRisk.values.risk).toBeUndefined()
    const withRisk = await core.assessToolCall({ ...baseInput, includeRiskScore: true })
    expect(withRisk.values.risk).toEqual({ score: 1.4, confidence: 0.6 })
  })

  it('does not transmit arguments that exceed the bound and applies the failure policy', async () => {
    const provider = assessmentProvider({})
    const core = createJevCore({ provider, mode: 'enforce', limits: { maxArgumentChars: 64 } })
    const assessment = await core.assessToolCall({
      ...baseInput,
      arguments: { path: '/repo/x', blob: 'x'.repeat(5000) },
    })
    expect(assessment.diagnostics.argumentsTruncated).toBe(true)
    expect(assessment.status).toBe('ask')
    expect(assessment.failure?.code).toBe('INCOMPLETE_INPUT')
    expect(assessment.decisions[0]?.rule).toBe('assessment.incomplete-input')
    expect(provider.callCount).toBe(0)
    expect(provider.requests).toEqual([])
  })

  it('holds incomplete arguments when configured to hold, without transmitting them', async () => {
    const provider = assessmentProvider({})
    const core = createJevCore({
      provider,
      mode: 'enforce',
      limits: { maxArgumentChars: 64 },
      onFailure: { toolAssessment: 'hold' },
    })
    const assessment = await core.assessToolCall({
      ...baseInput,
      arguments: { path: '/repo/x', blob: 'x'.repeat(5000) },
    })
    expect(assessment.status).toBe('hold')
    expect(assessment.applied).toBe(true)
    expect(assessment.failure?.code).toBe('INCOMPLETE_INPUT')
    expect(provider.callCount).toBe(0)
  })

  it('does not apply an incomplete-input decision in shadow mode', async () => {
    const provider = assessmentProvider({})
    const core = createJevCore({ provider, mode: 'shadow', limits: { maxArgumentChars: 64 } })
    const assessment = await core.assessToolCall({
      ...baseInput,
      arguments: { path: '/repo/x', blob: 'x'.repeat(5000) },
    })
    expect(assessment.status).toBe('ask')
    expect(assessment.applied).toBe(false)
    expect(provider.callCount).toBe(0)
  })

  it('treats a depth-limited argument bundle as incomplete input', async () => {
    const provider = assessmentProvider({})
    const core = createJevCore({ provider, mode: 'enforce', limits: { maxDepth: 2 } })
    const assessment = await core.assessToolCall({
      ...baseInput,
      arguments: { spec: { ingress: { from: { namespace: 'kube-system' } } } },
    })
    expect(assessment.diagnostics.argumentsTruncated).toBe(true)
    expect(assessment.status).toBe('ask')
    expect(assessment.failure?.code).toBe('INCOMPLETE_INPUT')
    expect(provider.callCount).toBe(0)
  })

  it('handles non-JSON leaves in arguments without throwing', async () => {
    const provider = assessmentProvider({})
    const core = coreWith(provider, 'enforce')
    const assessment = await core.assessToolCall({
      ...baseInput,
      arguments: {
        when: new Date('2026-01-01T00:00:00Z'),
        map: new Map([['a', 1]]),
        big: 10n,
        fn: () => 'nope',
      },
    })
    expect(assessment.status).toBe('allow')
    const sent = JSON.stringify(provider.requests)
    expect(sent).not.toContain('2026-01-01')
    // Unsupported leaves are rendered as bounded tags, never passed through raw.
    expect(sent).toContain('[function]')
    expect(sent).toContain('when')
  })
})
