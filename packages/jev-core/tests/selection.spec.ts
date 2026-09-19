import { describe, expect, it } from 'vitest'
import { createJevCore } from '../src/core.js'
import { MockJevProvider, type MockAnswerSpec, type MockScenario } from '../src/mock-provider.js'
import type { ToolCandidateInfo } from '../src/selection.js'

const candidates: ToolCandidateInfo[] = [
  { id: 'read_file', categories: ['files'], description: 'Read a file', priority: 1 },
  { id: 'write_file', categories: ['files'], description: 'Write a file', priority: 2 },
  { id: 'run_tests', categories: ['tests'], description: 'Run the test suite' },
  { id: 'grep', categories: ['files', 'search'], description: 'Search file contents' },
  { id: 'query_metrics', categories: ['monitoring'], description: 'Query monitoring metrics' },
]

function reactiveProvider(builder: (questionId: string, question: { type: string; criteria?: unknown }) => MockAnswerSpec): MockJevProvider {
  return new MockJevProvider({
    scenarioFor: (request): MockScenario => {
      const answers: Record<string, MockAnswerSpec> = {}
      for (const [questionId, question] of Object.entries(request.questions)) {
        answers[questionId] = builder(questionId, question)
      }
      return { answers }
    },
  })
}

describe('selectTools', () => {
  it('selects one tool per relevant category using independent relevance questions', async () => {
    const provider = reactiveProvider((id) => {
      if (id === 'rel_files') return { noul: 0.95 }
      if (id === 'rel_tests') return { noul: 0.8 }
      if (id === 'rel_search') return { noul: 0.1 }
      if (id === 'rel_monitoring') return { noul: 0.05 }
      if (id === 'pick_files') return { choice: 'read_file' }
      if (id === 'pick_tests') return { choice: 'run_tests' }
      return { noul: 0.5 }
    })
    const core = createJevCore({ provider, mode: 'enforce' })
    const plan = await core.selectTools({ task: 'Read the config and run tests', candidates })
    expect(plan.status).toBe('selected')
    expect(new Set(plan.selected)).toEqual(new Set(['read_file', 'run_tests']))
    expect(plan.expand).toEqual([])
    expect(plan.categories.find(category => category.category === 'search')?.relevant).toBe(false)
  })

  it('never transmits restricted candidates', async () => {
    const withRestricted: ToolCandidateInfo[] = [
      ...candidates,
      { id: 'delete_everything', categories: ['files'], description: 'Delete everything', restricted: true },
    ]
    const provider = reactiveProvider((id) => {
      if (id.startsWith('rel_')) return { noul: 0.9 }
      if (id.startsWith('pick_')) return { choice: 'read_file' }
      return { noul: 0.5 }
    })
    const core = createJevCore({ provider, mode: 'enforce' })
    const plan = await core.selectTools({ task: 'Inspect files', candidates: withRestricted })
    expect(plan.diagnostics.restrictedSkipped).toEqual(['delete_everything'])
    const sent = JSON.stringify(provider.requests)
    expect(sent).not.toContain('delete_everything')
  })

  it('abstains explicitly when no candidate wins', async () => {
    const provider = reactiveProvider((id) => {
      if (id.startsWith('rel_')) return { noul: 0.9 }
      if (id.startsWith('pick_')) return { choice: '__none__' }
      return { noul: 0.5 }
    })
    const core = createJevCore({ provider, mode: 'enforce' })
    const plan = await core.selectTools({ task: 'Unrelated task', candidates })
    expect(plan.status).toBe('abstained')
    expect(plan.selected).toEqual([])
  })

  it('keeps plausible alternatives for controlled expansion on uncertainty', async () => {
    const provider = reactiveProvider((id) => {
      if (id === 'rel_files') return { noul: 0.9 }
      if (id.startsWith('rel_')) return { noul: 0.1 }
      if (id === 'pick_files') {
        return {
          choice: {
            choice: 'grep',
            confidence: 0.2,
            probabilities: { read_file: 0.3, write_file: 0.2, grep: 0.4, __none__: 0.1 },
          },
        }
      }
      return { noul: 0.5 }
    })
    const core = createJevCore({ provider, mode: 'enforce', thresholds: { confidence: 0.5 } })
    const plan = await core.selectTools({ task: 'Ambiguous file task', candidates })
    expect(plan.selected).toContain('grep')
    expect(plan.expand).toContain('read_file')
    expect(plan.status).toBe('selected')
  })

  it('falls back to the existing flow when the provider fails', async () => {
    const provider = new MockJevProvider({ scenario: { error: { code: 'CONNECTION', retryable: true } } })
    const core = createJevCore({ provider, mode: 'enforce' })
    const plan = await core.selectTools({ task: 'task', candidates })
    expect(plan.status).toBe('fallback')
    expect(plan.failure?.code).toBe('CONNECTION')
    expect(plan.selected).toEqual([])
  })

  it('makes no provider call in off mode', async () => {
    const provider = reactiveProvider(() => ({ noul: 0.9 }))
    const core = createJevCore({ provider, mode: 'off' })
    const plan = await core.selectTools({ task: 'task', candidates })
    expect(plan.status).toBe('off')
    expect(provider.callCount).toBe(0)
  })

  it('records the deterministic cap instead of silently dropping selections', async () => {
    const many = Array.from({ length: 6 }, (_, index): ToolCandidateInfo => ({
      id: `tool_${index}`,
      categories: ['tools'],
      description: `Tool ${index}`,
      priority: index,
    }))
    const provider = new MockJevProvider({
      scenarioFor: () => ({
        answers: {
          rel_tools: { noul: 0.95 },
          pick_tools: { choice: 'tool_0' },
        },
      }),
    })
    const core = createJevCore({ provider, mode: 'enforce' })
    const plan = await core.selectTools({ task: 'task', candidates: many, maxSelected: 1 })
    expect(plan.selected).toEqual(['tool_0'])
  })

  it('chunks candidates so nothing is silently truncated', async () => {
    const many = Array.from({ length: 5 }, (_, index): ToolCandidateInfo => ({
      id: `tool_${index}`,
      categories: ['tools'],
      description: `Tool ${index}`,
    }))
    const provider = reactiveProvider((id, question) => {
      if (id === 'rel_tools') return { noul: 0.95 }
      if (id.startsWith('pick_tools')) {
        const labels = Object.keys(question.criteria as Record<string, unknown>).filter(label => label !== '__none__')
        const chosen = labels[labels.length - 1] as string
        const probabilities: Record<string, number> = { __none__: 0 }
        for (const label of labels) probabilities[label] = label === chosen ? 1 : 0
        return { choice: { choice: chosen, confidence: 1, probabilities } }
      }
      return { noul: 0.5 }
    })
    const core = createJevCore({ provider, mode: 'enforce', limits: { maxCandidatesPerQuestion: 2 } })
    const plan = await core.selectTools({ task: 'task', candidates: many })
    expect(plan.diagnostics.questionSizes.map(size => size.options)).toEqual([3, 3, 2])
    expect(plan.selected).toEqual(['tool_1', 'tool_3', 'tool_4'])
  })
})
