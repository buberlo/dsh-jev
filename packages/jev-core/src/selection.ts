/**
 * Tool selection: derive a relevant, bounded tool set for one task.
 *
 * Independent categories are asked as independent questions (one Noul per
 * category plus one Choice per relevant category). A single distribution over
 * all tools would not be an independent relevance signal for tools that are
 * relevant at the same time, so it is deliberately not used.
 *
 * Candidate metadata is trusted local data; the task text is untrusted and
 * only ever travels as question `state`. `restricted` candidates are removed
 * before anything is transmitted.
 *
 * @module jev-core/selection
 */

import type { Questions, ResultFor, Question, EntryType, Usage } from '@typesafe-ai/sdk'
import type { JevCore } from './core.js'
import { choice, noul } from './primitives.js'
import type { EvaluationDiagnostics, JevFailure, JevMode } from './types.js'

/** One tool category with an optional trusted description. */
export interface ToolCategoryInfo {
  readonly id: string
  readonly description?: string
}

/** One selectable tool. `id` must be the stable harness tool id. */
export interface ToolCandidateInfo {
  readonly id: string
  /** Categories this tool serves; a tool may serve several at once. */
  readonly categories: readonly string[]
  /** Short trusted description used as the choice criterion. */
  readonly description?: string
  /** When true the tool is already forbidden and is never sent to Jev. */
  readonly restricted?: boolean
  /** Optional selection priority; lower wins when a cap forces a pre-selection. */
  readonly priority?: number
}

/** Input for one tool-selection evaluation. */
export interface ToolSelectionInput {
  /** The user task / current turn summary (untrusted text). */
  readonly task: string
  /** The current work step, when known. */
  readonly step?: string
  readonly candidates: readonly ToolCandidateInfo[]
  /** Category descriptions; unknown categories fall back to the raw id. */
  readonly categories?: readonly ToolCategoryInfo[]
  /** Tool ids that may never be hidden by a selection restriction. */
  readonly alwaysAllow?: readonly string[]
  /** Optional cap on selected tool ids. */
  readonly maxSelected?: number
  readonly signal?: AbortSignal | undefined
  /** Per-call mode override. */
  readonly mode?: JevMode | undefined
}

/** One category's outcome. */
export interface CategoryOutcome {
  readonly category: string
  /** Independent relevance probability from the Noul question. */
  readonly relevance: number
  readonly relevant: boolean
  /** The candidate choice, when a pick question was asked. */
  readonly pick?: {
    readonly choice: string
    readonly probability: number
    readonly confidence: number
    /** Selected tool ids from this category. */
    readonly selected: readonly string[]
    /** Additional plausible candidates kept for controlled expansion. */
    readonly expand: readonly string[]
  }
}

/** Diagnostics for one selection run. */
export interface SelectionDiagnostics extends EvaluationDiagnostics {
  /** Candidate ids that were never transmitted because they were restricted. */
  readonly restrictedSkipped: readonly string[]
  /** Candidate ids removed by a cap; includes the reason. */
  readonly prefiltered: readonly { readonly id: string; readonly reason: string }[]
  /** Selection stages executed, e.g. `relevance:batch-1`, `pick:docker`. */
  readonly stages: readonly string[]
  /** Candidate count per question after chunking. */
  readonly questionSizes: readonly { readonly questionId: string; readonly options: number }[]
}

/** Result of one tool-selection evaluation. */
export interface ToolSelectionPlan {
  readonly status: 'selected' | 'abstained' | 'fallback' | 'off'
  /** Tool ids the caller may keep visible (never a superset of `candidates`). */
  readonly selected: readonly string[]
  /** Additional plausible ids the caller may keep for controlled expansion. */
  readonly expand: readonly string[]
  /** Ids that must stay visible regardless of the selection. */
  readonly alwaysAllow: readonly string[]
  readonly categories: readonly CategoryOutcome[]
  readonly failure?: JevFailure
  readonly diagnostics: SelectionDiagnostics
}

const NO_TOOL = '__none__'
const RELEVANCE_PREFIX = 'rel_'
const PICK_PREFIX = 'pick_'

function categoryQuestionId(category: string): string {
  return `${RELEVANCE_PREFIX}${sanitizeId(category)}`
}

function pickQuestionId(category: string, chunk: number): string {
  return `${PICK_PREFIX}${sanitizeId(category)}${chunk === 0 ? '' : `_${chunk}`}`
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, '_')
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

type AnswerUnion = ResultFor<Question>

function readNoul(answers: Readonly<Record<string, AnswerUnion>>, id: string): number | undefined {
  const answer = answers[id]
  return answer?.type === 'noul' ? answer.noul : undefined
}

function readChoice(answers: Readonly<Record<string, AnswerUnion>>, id: string): {
  choice: string
  probability: number
  confidence: number
  probabilities: Readonly<Record<string, number>>
} | undefined {
  const answer = answers[id]
  if (answer?.type !== 'choice') return undefined
  return {
    choice: answer.choice,
    probability: answer.probabilities[answer.choice] ?? 0,
    confidence: answer.confidence,
    probabilities: answer.probabilities,
  }
}

/** Chunk an array into consecutive groups of at most `size`. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size))
  return out
}

/**
 * Derive a bounded tool selection for one task.
 * @param core - the configured decision core.
 * @param input - task, candidates, and bounds.
 * @returns the selection plan; failures yield `status: 'fallback'`.
 */
export async function selectTools(core: JevCore, input: ToolSelectionInput): Promise<ToolSelectionPlan> {
  const mode = input.mode ?? core.config.mode
  const limits = core.config.limits
  const thresholds = core.config.thresholds
  const maxSelected = input.maxSelected ?? limits.maxSelectedTools
  const alwaysAllow = [...new Set(input.alwaysAllow ?? [])]
  const restrictedSkipped: string[] = []
  const prefiltered: { id: string; reason: string }[] = []
  const stages: string[] = []
  const baseDiagnostics = {
    provider: core.config.provider.kind,
    mode,
    latencyMs: 0,
    stateChars: 0,
    stateTruncated: false,
    restrictedSkipped: [] as string[],
    prefiltered: [] as { id: string; reason: string }[],
    questionSizes: [] as { questionId: string; options: number }[],
  }

  if (mode === 'off') {
    return {
      status: 'off',
      selected: [],
      expand: [],
      alwaysAllow,
      categories: [],
      diagnostics: { ...baseDiagnostics, stages: ['mode:off'] },
    }
  }

  // 1. Local prefilter: restricted tools never leave the process.
  const seen = new Set<string>()
  let latencyMs = 0
  let model: string | undefined
  let usage: Usage | undefined
  const record = (diagnostics: EvaluationDiagnostics): void => {
    latencyMs += diagnostics.latencyMs
    if (diagnostics.model !== undefined) model = diagnostics.model
    if (diagnostics.usage !== undefined) usage = diagnostics.usage
  }
  const allowed: ToolCandidateInfo[] = []
  for (const candidate of input.candidates) {
    if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
      prefiltered.push({ id: String(candidate.id), reason: 'empty tool id' })
      continue
    }
    if (seen.has(candidate.id)) {
      prefiltered.push({ id: candidate.id, reason: 'duplicate tool id' })
      continue
    }
    seen.add(candidate.id)
    if (candidate.restricted === true) {
      restrictedSkipped.push(candidate.id)
      continue
    }
    allowed.push(candidate)
  }

  // 2. Group by category, preserving first-seen category order.
  const categoryOrder: string[] = []
  const groups = new Map<string, ToolCandidateInfo[]>()
  for (const candidate of allowed) {
    const categories = candidate.categories.length > 0 ? candidate.categories : ['uncategorized']
    for (const category of categories) {
      let bucket = groups.get(category)
      if (bucket === undefined) {
        bucket = []
        groups.set(category, bucket)
        categoryOrder.push(category)
      }
      bucket.push(candidate)
    }
  }

  if (groups.size === 0) {
    return {
      status: 'abstained',
      selected: [],
      expand: [],
      alwaysAllow,
      categories: [],
      diagnostics: {
        ...baseDiagnostics,
        restrictedSkipped,
        prefiltered,
        stages: ['prefilter:no-candidates'],
      },
    }
  }

  const categoryDescriptions = new Map<string, string | undefined>()
  for (const info of input.categories ?? []) categoryDescriptions.set(info.id, info.description)
  for (const category of categoryOrder) {
    if (!categoryDescriptions.has(category)) categoryDescriptions.set(category, undefined)
  }

  const state: EntryType = {
    task: truncate(input.task, limits.maxStateChars),
    ...(input.step === undefined ? {} : { step: truncate(input.step, Math.floor(limits.maxStateChars / 4)) }),
  }

  const failingResult = (failure: JevFailure, failedLatencyMs: number): ToolSelectionPlan => ({
    status: 'fallback',
    selected: [],
    expand: [],
    alwaysAllow,
    categories: [],
    failure,
    diagnostics: {
      ...baseDiagnostics,
      latencyMs: latencyMs + failedLatencyMs,
      ...(model === undefined ? {} : { model }),
      ...(usage === undefined ? {} : { usage }),
      restrictedSkipped,
      prefiltered,
      stateChars: JSON.stringify(state).length,
      stages,
    },
  })

  // 3. Stage one: independent relevance per category, chunked to the batch cap.
  const relevance: Record<string, number> = {}
  const relevanceChunks = chunk(categoryOrder, limits.maxCategories)
  for (const [index, categoriesInChunk] of relevanceChunks.entries()) {
    stages.push(`relevance:batch-${index + 1}`)
    const questions: Record<string, Question> = {}
    for (const category of categoriesInChunk) {
      const description = categoryDescriptions.get(category)
      questions[categoryQuestionId(category)] = noul(
        `Is a tool from the category "${category}" relevant for completing the current task?`,
        {
          true: description === undefined ? 'At least one tool from this category helps with the task.' : description,
          false: 'No tool from this category is needed for this task.',
        },
      )
    }
    const result = await core.evaluate<Questions>({
      state,
      questions,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      mode,
    })
    if (!result.ok) return failingResult(result.failure, result.diagnostics.latencyMs)
    record(result.diagnostics)
    for (const category of categoriesInChunk) {
      relevance[category] = readNoul(result.answers as Readonly<Record<string, AnswerUnion>>, categoryQuestionId(category)) ?? 0
    }
  }

  const relevantCategories = categoryOrder.filter(category => (relevance[category] ?? 0) >= thresholds.relevance)

  // 4. Stage two: one candidate choice per relevant category, chunked so no
  //    candidate is dropped silently (TypeSafe accepts at most 255 options).
  const outcomes: CategoryOutcome[] = []
  const selectedAll: string[] = []
  const expandAll: string[] = []
  const questionSizes: { questionId: string; options: number }[] = []
  const maxPerQuestion = Math.min(limits.maxCandidatesPerQuestion, limits.maxOptionsPerQuestion - 1)

  for (const category of categoryOrder) {
    const probability = relevance[category] ?? 0
    const relevant = relevantCategories.includes(category)
    if (!relevant) {
      outcomes.push({ category, relevance: probability, relevant })
      continue
    }
    const members = [...(groups.get(category) ?? [])].sort((a, b) => {
      const priority = (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER)
      return priority !== 0 ? priority : a.id.localeCompare(b.id)
    })
    const candidateChunks = chunk(members, maxPerQuestion)
    const categorySelected: string[] = []
    const categoryExpand: string[] = []
    let firstPick: CategoryOutcome['pick']
    for (const [index, candidateChunk] of candidateChunks.entries()) {
      const questionId = pickQuestionId(category, index)
      if (candidateChunks.length > 1) stages.push(`pick:${category}:chunk-${index + 1}`)
      else stages.push(`pick:${category}`)
      const criteria: Record<string, string | null> = {}
      for (const candidate of candidateChunk) {
        criteria[candidate.id] = candidate.description === undefined ? null : truncate(candidate.description, 200)
      }
      criteria[NO_TOOL] = 'No tool from this category fits the current task step.'
      questionSizes.push({ questionId, options: Object.keys(criteria).length })
      const questions: Questions = {
        [questionId]: choice(`Which tool from the category "${category}" fits the current task step?`, criteria),
      }
      const result = await core.evaluate<Questions>({
        state,
        questions,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        mode,
      })
      if (!result.ok) return failingResult(result.failure, result.diagnostics.latencyMs)
      record(result.diagnostics)
      const answer = readChoice(result.answers as Readonly<Record<string, AnswerUnion>>, questionId)
      if (answer === undefined) continue
      if (answer.choice !== NO_TOOL && answer.probability >= thresholds.selection) {
        categorySelected.push(answer.choice)
      }
      const uncertain = answer.choice === NO_TOOL
        || answer.probability < thresholds.selection
        || answer.confidence < thresholds.confidence
      if (uncertain) {
        const alternatives = Object.entries(answer.probabilities)
          .filter(([label]) => label !== NO_TOOL && label !== answer.choice)
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, 2)
          .map(([label]) => label)
        categoryExpand.push(...alternatives)
      }
      if (firstPick === undefined) {
        firstPick = {
          choice: answer.choice,
          probability: answer.probability,
          confidence: answer.confidence,
          selected: [...categorySelected],
          expand: [...categoryExpand],
        }
      }
    }
    if (firstPick !== undefined) {
      firstPick = { ...firstPick, selected: [...categorySelected], expand: [...categoryExpand] }
    }
    selectedAll.push(...categorySelected)
    expandAll.push(...categoryExpand)
    outcomes.push({
      category,
      relevance: probability,
      relevant,
      ...(firstPick === undefined ? {} : { pick: firstPick }),
    })
  }

  // 5. Deterministic cap; every removed id is recorded.
  const uniqueSelected = [...new Set(selectedAll)]
  const cappedSelected = uniqueSelected.slice(0, maxSelected)
  for (const id of uniqueSelected.slice(maxSelected)) prefiltered.push({ id, reason: 'maxSelected cap' })
  const uniqueExpand = [...new Set(expandAll)].filter(id => !cappedSelected.includes(id)).slice(0, maxSelected)
  const uniqueAlways = [...new Set([...alwaysAllow, ...cappedSelected])]

  stages.push(`policy:${cappedSelected.length}-selected`)

  return {
    status: cappedSelected.length > 0 ? 'selected' : 'abstained',
    selected: cappedSelected,
    expand: uniqueExpand,
    alwaysAllow: uniqueAlways,
    categories: outcomes,
    diagnostics: {
      ...baseDiagnostics,
      latencyMs,
      ...(model === undefined ? {} : { model }),
      ...(usage === undefined ? {} : { usage }),
      restrictedSkipped,
      prefiltered,
      stateChars: JSON.stringify(state).length,
      stages,
      questionSizes,
    },
  }
}

/** Stable local signature for one selection plan (diagnostics only). */
export function selectionSignature(plan: ToolSelectionPlan): string {
  const payload = JSON.stringify({
    status: plan.status,
    selected: [...plan.selected].sort(),
    expand: [...plan.expand].sort(),
    categories: plan.categories.map(category => ({
      category: category.category,
      relevance: category.relevance,
      pick: category.pick?.choice,
      probability: category.pick?.probability,
    })),
  })
  let hash = 0
  for (let index = 0; index < payload.length; index += 1) {
    hash = (Math.imul(hash, 31) + payload.charCodeAt(index)) >>> 0
  }
  return hash.toString(16)
}
