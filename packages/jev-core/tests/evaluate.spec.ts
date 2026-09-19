import { describe, expect, it } from 'vitest'
import { createJevCore } from '../src/core.js'
import { JevError } from '../src/errors.js'
import { MockJevProvider } from '../src/mock-provider.js'
import { noul } from '../src/primitives.js'
import type { DecisionRule } from '../src/types.js'

const rules: DecisionRule[] = [
  { id: 'escalate', kind: 'noul-at-least', question: 'escalate', value: 0.7, action: 'ask', reason: 'escalation likely' },
  { id: 'calm', kind: 'noul-below', question: 'escalate', value: 0.2, action: 'deny', reason: 'explicitly not needed' },
]

function coreWith(provider: MockJevProvider, mode: 'off' | 'shadow' | 'enforce', amount = 0.9) {
  return createJevCore({
    provider,
    mode,
    thresholds: { restriction: amount },
  })
}

describe('JevCore.evaluate', () => {
  it('does not call the provider in off mode', async () => {
    const provider = new MockJevProvider()
    const core = coreWith(provider, 'off')
    const result = await core.evaluate({ state: 's', questions: { escalate: noul('Escalate?') } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.code).toBe('OFF')
    expect(provider.callCount).toBe(0)
  })

  it('marks decisions as not applied in shadow mode', async () => {
    const provider = new MockJevProvider({ scenario: { answers: { escalate: { noul: 0.95 } } } })
    const core = coreWith(provider, 'shadow')
    const result = await core.evaluate({ state: 's', questions: { escalate: noul('Escalate?') }, rules })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.decisions).toHaveLength(1)
    expect(result.decisions[0]).toMatchObject({ action: 'ask', applied: false, rule: 'escalate' })
    expect(result.diagnostics.provider).toBe('mock')
    expect(result.diagnostics.mode).toBe('shadow')
  })

  it('marks decisions as applied in enforce mode', async () => {
    const provider = new MockJevProvider({ scenario: { answers: { escalate: { noul: 0.95 } } } })
    const core = coreWith(provider, 'enforce')
    const result = await core.evaluate({ state: 's', questions: { escalate: noul('Escalate?') }, rules })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.decisions[0]?.applied).toBe(true)
  })

  it('returns structured failures instead of throwing', async () => {
    const provider = new MockJevProvider({ scenario: { error: { code: 'RATE_LIMIT', retryable: true } } })
    const core = coreWith(provider, 'enforce')
    const result = await core.evaluate({ state: 's', questions: { escalate: noul('Escalate?') } })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failure.code).toBe('RATE_LIMIT')
      expect(result.failure.retryable).toBe(true)
      expect(result.decisions).toEqual([])
    }
  })

  it('classifies a budget overrun as a timeout', async () => {
    const provider = new MockJevProvider({ delayMs: 100 })
    const core = createJevCore({ provider, mode: 'enforce', limits: { budgetMs: 20 } })
    const result = await core.evaluate({ state: 's', questions: { escalate: noul('Escalate?') } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.code).toBe('TIMEOUT')
  })

  it('propagates caller cancellation as ABORTED', async () => {
    const provider = new MockJevProvider({ delayMs: 1000 })
    const core = createJevCore({ provider, mode: 'enforce', limits: { budgetMs: 5000 } })
    const controller = new AbortController()
    const pending = core.evaluate({ state: 's', questions: { escalate: noul('Escalate?') }, signal: controller.signal })
    controller.abort()
    const result = await pending
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.code).toBe('ABORTED')
  })

  it('bounds the transmitted state and reports truncation', async () => {
    const provider = new MockJevProvider()
    const core = createJevCore({ provider, mode: 'shadow', limits: { maxStateChars: 10 } })
    const result = await core.evaluate({ state: 'x'.repeat(100), questions: { q: noul('Q?') } })
    expect(result.ok).toBe(true)
    expect(result.diagnostics.stateTruncated).toBe(true)
    expect(result.diagnostics.stateChars).toBe(10)
    const transmitted = provider.requests[0]?.state as string
    expect(transmitted).toContain('[state truncated]')
    expect(transmitted.length).toBeLessThan(60)
  })

  it('rejects an assessment failure policy that would allow', () => {
    expect(() => createJevCore({
      provider: new MockJevProvider(),
      mode: 'enforce',
      onFailure: { toolAssessment: 'fallback' as unknown as 'ask' },
    })).toThrowError(JevError)
  })

  it('validates thresholds and limits', () => {
    expect(() => createJevCore({ provider: new MockJevProvider(), thresholds: { relevance: 2 } })).toThrowError(/\[0, 1\]/)
    expect(() => createJevCore({ provider: new MockJevProvider(), limits: { budgetMs: 0 } })).toThrowError(/positive integer/)
  })

  it('aborts every in-flight request on abortAll', async () => {
    const provider = new MockJevProvider({ delayMs: 1000 })
    const core = createJevCore({ provider, mode: 'shadow', limits: { maxConcurrent: 2, budgetMs: 5000 } })
    const pending = core.evaluate({ state: 's', questions: { q: noul('Q?') } })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(core.activeRequests).toBe(1)
    core.abortAll(new Error('disposed'))
    const result = await pending
    expect(result.ok).toBe(false)
    expect(core.activeRequests).toBe(0)
  })
})
