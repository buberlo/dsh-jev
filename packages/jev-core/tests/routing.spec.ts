import { describe, expect, it } from 'vitest'
import { createJevCore } from '../src/core.js'
import { MockJevProvider, type MockAnswerSpec, type MockScenario } from '../src/mock-provider.js'

describe('routeSkills', () => {
  const skills = [
    { name: 'test-runner', description: 'Runs the repository test suite' },
    { name: 'docs-writer', description: 'Writes documentation', whenToUse: 'only for documentation tasks' },
  ]

  it('selects the most relevant skill', async () => {
    const provider = new MockJevProvider({
      scenario: { answers: { needs_skill: { noul: 0.9 }, skill: { choice: { choice: 'test-runner', confidence: 1 } } } },
    })
    const core = createJevCore({ provider, mode: 'enforce' })
    const result = await core.routeSkills({ task: 'Run the tests for the parser', candidates: skills })
    expect(result.status).toBe('selected')
    expect(result.skill).toBe('test-runner')
  })

  it('returns none when no skill is needed', async () => {
    const provider = new MockJevProvider({
      scenario: { answers: { needs_skill: { noul: 0.95 }, skill: { choice: { choice: '__none__', confidence: 1 } } } },
    })
    const core = createJevCore({ provider, mode: 'enforce' })
    const result = await core.routeSkills({ task: 'Hello', candidates: skills })
    expect(result.status).toBe('none')
    expect(result.skill).toBeUndefined()
  })

  it('returns none on low confidence instead of injecting the wrong skill', async () => {
    const provider = new MockJevProvider({
      scenario: { answers: { needs_skill: { noul: 0.95 }, skill: { choice: { choice: 'docs-writer', confidence: 0.1 } } } },
    })
    const core = createJevCore({ provider, mode: 'enforce' })
    const result = await core.routeSkills({ task: 'Ambiguous', candidates: skills })
    expect(result.status).toBe('none')
  })

  it('falls back without a skill when the provider fails', async () => {
    const provider = new MockJevProvider({ scenario: { error: { code: 'CONNECTION' } } })
    const core = createJevCore({ provider, mode: 'enforce' })
    const result = await core.routeSkills({ task: 'Task', candidates: skills })
    expect(result.status).toBe('fallback')
  })

  it('sends only routing metadata, never skill bodies', async () => {
    const provider = new MockJevProvider()
    const core = createJevCore({ provider, mode: 'enforce' })
    await core.routeSkills({ task: 'Task', candidates: skills })
    const sent = JSON.stringify(provider.requests)
    expect(sent).toContain('test-runner')
    expect(sent).not.toContain('skill body content')
  })
})

describe('routeModel', () => {
  const available = [
    { provider: 'deepseek', model: 'deepseek-v4-flash' },
    { provider: 'deepseek', model: 'deepseek-v4-pro' },
  ]
  const routes = {
    fast: { provider: 'deepseek', model: 'deepseek-v4-flash' },
    reasoning: { provider: 'deepseek', model: 'deepseek-v4-pro' },
  }

  it('routes to a configured, available target', async () => {
    const provider = new MockJevProvider({
      scenarioFor: (request): MockScenario => ({
        answers: Object.fromEntries(Object.keys(request.questions).map((id): [string, MockAnswerSpec] => [
          id, { choice: { choice: 'reasoning', confidence: 1 } },
        ])),
      }),
    })
    const core = createJevCore({ provider, mode: 'enforce' })
    const result = await core.routeModel({
      task: 'Prove the concurrency invariant',
      routes,
      defaultTarget: available[0],
      available,
    })
    expect(result.status).toBe('routed')
    expect(result.target).toEqual(routes.reasoning)
  })

  it('falls back when the chosen target is not available', async () => {
    const provider = new MockJevProvider({
      scenario: { answers: { route: { choice: { choice: 'reasoning', confidence: 1 } } } },
    })
    const core = createJevCore({ provider, mode: 'enforce' })
    const result = await core.routeModel({
      task: 'Task',
      routes,
      defaultTarget: available[0],
      available: [available[0]],
    })
    expect(result.status).toBe('fallback')
    expect(result.target).toEqual(available[0])
    expect(result.reason).toContain('not available')
  })

  it('keeps the existing model when no route is configured', async () => {
    const provider = new MockJevProvider()
    const core = createJevCore({ provider, mode: 'enforce' })
    const result = await core.routeModel({
      task: 'Task',
      routes: {},
      defaultTarget: available[0],
      available,
    })
    expect(result.status).toBe('fallback')
    expect(provider.callCount).toBe(0)
  })

  it('falls back to the existing model on provider failure', async () => {
    const provider = new MockJevProvider({ scenario: { error: { code: 'TIMEOUT', retryable: true } } })
    const core = createJevCore({ provider, mode: 'enforce' })
    const result = await core.routeModel({
      task: 'Task',
      routes,
      defaultTarget: available[0],
      available,
    })
    expect(result.status).toBe('fallback')
    expect(result.target).toEqual(available[0])
  })
})
