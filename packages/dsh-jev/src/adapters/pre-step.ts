/**
 * Pre-step adapter: per-turn task snapshot, dynamic tool selection, and
 * optional skill routing.
 *
 * Both decisions are prepared before the model request is assembled, and a
 * selection restriction is replaced (not accumulated) on every step, which is
 * the recovery path for a bad selection: the next step recomputes from the
 * unrestricted catalog, and any failure falls back to the existing flow.
 *
 * @module dsh-jev/adapters/pre-step
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { combineSignals } from '@buberlo/jev-core'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { boundContextSummary, createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import { isModelInvocable } from '@deepseek-ai/dsh-skill'
import { buildSelectionCatalog } from '../config.js'
import { describeThrown, type JevRuntime } from '../service.js'
import type { AgentState } from '../state.js'

// The message-source vocabulary is merge-extensible (rc.1 has no shared
// catch-all `plugin` kind): each producer declares its own kind.
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-jev': { kind: 'dsh-jev' } & ContextFormed
  }
}

/** Install the pre-step listeners. */
export function installPreStepAdapter(ctx: Context, runtime: JevRuntime): void {
  ctx.on('agent/pre-step', async (payload, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (runtime.mode === 'off') return decision
    if (decision.kind === 'reject') return decision
    const { agent, messages, turn, step, signal } = payload
    const state = runtime.ensureState(agent)
    const task = extractTask(messages, runtime.settings.maxStateChars)
      ?? extractSessionTask(agent, runtime.settings.maxStateChars)
      ?? state.snapshot.task
    state.updateSnapshot({ task, step: `step ${step}`, turn })
    state.liftSelection()

    const controller = new AbortController()
    state.addInFlight(controller)
    const combined = combineSignals([signal, controller.signal])
    try {
      if (runtime.settings.selection.enabled) {
        await runSelection(ctx, runtime, agent, state, combined)
      }
      if (runtime.settings.skills.enabled) {
        await runSkills(ctx, runtime, agent, state, combined, turn)
      }
    } catch (error) {
      runtime.log('warn', `pre-step decision failed: ${describeThrown(error)}`)
    } finally {
      state.removeInFlight(controller)
    }
    return decision
  })
}

/** Bounded task text from the admitted messages; the newest user text wins. */
function extractTask(messages: readonly UserMessage[], max: number): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined || message.source.kind !== 'user') continue
    const text = message.content
      .filter(block => block.type === 'text')
      .map(block => block.type === 'text' ? block.text : '')
      .join('\n')
      .trim()
    if (text.length > 0) return text.length <= max ? text : `${text.slice(0, max)}…`
  }
  return undefined
}

/** Fallback: newest user message from the durable session history. */
function extractSessionTask(agent: Agent, max: number): string | undefined {
  try {
    const messages = agent.session.deriveMessages()
    const userMessages = messages.filter(message => message.role === 'user' && message.source.kind === 'user')
    const last = userMessages[userMessages.length - 1]
    if (last === undefined) return undefined
    const text = last.content
      .filter(block => block.type === 'text')
      .map(block => block.type === 'text' ? block.text : '')
      .join('\n')
      .trim()
    if (text.length === 0) return undefined
    return text.length <= max ? text : `${text.slice(0, max)}…`
  } catch {
    return undefined
  }
}

/**
 * Compute one selection and apply the resulting restriction in enforce mode.
 * The selection can only keep a subset of the currently visible global tools:
 * pre-existing restrictions are resolved before the candidate set is built, so
 * a Jev selection never widens an existing permission.
 */
async function runSelection(
  ctx: Context,
  runtime: JevRuntime,
  agent: Agent,
  state: AgentState,
  signal: AbortSignal,
): Promise<void> {
  const settings = runtime.settings
  const schemas = ctx.tools.schemas(agent).filter(schema => ctx.tools.get(schema.name) !== undefined)
  if (schemas.length === 0) {
    // Fail-open: an empty restrictable catalog leaves the turn and the
    // existing tool set alone. Warn once per agent so a matrix mismatch
    // (or a catalog that stays empty) is visible without a log per step.
    if (!state.warnedEmptySelectionCatalog) {
      state.warnedEmptySelectionCatalog = true
      runtime.log('warn', 'tool selection skipped: tool catalog resolved empty for this agent', {
        schemas: 0,
      })
    }
    return
  }
  const { candidates, categories } = buildSelectionCatalog(schemas, settings)

  const snapshotVersion = state.snapshot.version
  const catalogVersion = runtime.catalogVersion
  const plan = await runtime.core.selectTools({
    task: state.snapshot.task,
    step: state.snapshot.step,
    candidates,
    categories,
    alwaysAllow: settings.selection.alwaysAllow,
    signal,
    mode: runtime.mode,
  })
  runtime.stats.selections += 1
  if (plan.failure !== undefined) runtime.stats.selectionFailures += 1
  if (plan.status === 'abstained') runtime.stats.abstentions += 1
  runtime.log('info', `tool selection ${plan.status}`, {
    mode: runtime.mode,
    selected: plan.selected.length,
    expand: plan.expand.length,
    categories: plan.categories.filter(category => category.relevant).length,
    stages: plan.diagnostics.stages.length,
    latencyMs: Math.round(plan.diagnostics.latencyMs),
    model: plan.diagnostics.model,
    failure: plan.failure?.code,
  })

  if (runtime.mode !== 'enforce') return
  // Failure or an explicit "no candidate" keeps the existing tool set; a Jev
  // decision is only ever a narrowing, never a gate for the whole turn.
  if (plan.status !== 'selected') return
  if (state.snapshot.version !== snapshotVersion || runtime.catalogVersion !== catalogVersion) {
    runtime.stats.staleDiscarded += 1
    runtime.log('warn', 'tool selection discarded: snapshot changed while evaluating')
    return
  }
  const allow = [...new Set([...plan.selected, ...plan.expand, ...settings.selection.alwaysAllow])]
    .filter(name => ctx.tools.get(name) !== undefined)
  if (allow.length === 0) return
  try {
    state.applySelection(() => agent.ctx.tools.restrict({ allow }))
    state.selectionCatalogVersion = catalogVersion
    runtime.stats.restrictionsApplied += 1
    runtime.log('info', 'tool selection restriction applied', { allow: allow.length })
  } catch (error) {
    runtime.log('warn', `tool selection restriction rejected: ${describeThrown(error)}`)
  }
}

/**
 * Skill routing: suggest at most one model-invocable skill. In enforce mode a
 * one-line notice is injected; the skill body is never loaded automatically.
 */
async function runSkills(
  ctx: Context,
  runtime: JevRuntime,
  agent: Agent,
  state: AgentState,
  signal: AbortSignal,
  turn: number,
): Promise<void> {
  // One hint per turn: re-injecting on later steps of the same turn would keep
  // waking the driver with new context and never let the turn settle.
  if (state.skillHintTurn === turn) return
  const skills = ctx.get('skills')
  if (skills === undefined) return
  const catalog = await skills.list({ scope: agent })
  const hints = runtime.settings.skills.routingHints
  const candidates = catalog
    .filter(isModelInvocable)
    .slice(0, runtime.settings.maxSkills)
    .map(skill => {
      // A configured routing hint is appended to the skill's own whenToUse and
      // never edits the skill file, so vendored content stays diffable.
      const hint = hints[skill.name]
      const whenToUse = [skill.whenToUse, hint]
        .filter((part): part is string => part !== undefined && part.length > 0)
        .join(' ')
      return {
        name: skill.name,
        description: skill.description,
        ...(whenToUse.length === 0 ? {} : { whenToUse }),
      }
    })
  if (candidates.length === 0) return

  const snapshotVersion = state.snapshot.version
  const result = await runtime.core.routeSkills({
    task: state.snapshot.task,
    step: state.snapshot.step,
    candidates,
    maxDescriptionChars: runtime.settings.skills.maxDescriptionChars,
    signal,
    mode: runtime.mode,
  })
  runtime.log('info', `skill routing ${result.status}`, {
    skill: result.skill,
    needsSkill: result.needsSkill,
    probability: result.probability,
    confidence: result.confidence,
    failure: result.failure?.code,
  })
  if (runtime.mode !== 'enforce') return
  if (result.status !== 'selected' || result.skill === undefined) return
  if (!runtime.settings.skills.injectHint) return
  if (state.snapshot.version !== snapshotVersion) {
    runtime.stats.staleDiscarded += 1
    runtime.log('warn', 'skill suggestion discarded: snapshot changed while evaluating')
    return
  }
  state.skillHintVersion = snapshotVersion
  state.skillHintTurn = turn
  const selected = candidates.find(candidate => candidate.name === result.skill)
  const detail = selected === undefined ? '' : ` — ${selected.description}`
  agent.inject(createUserMessage({
    content: [{
      type: 'text',
      text: `Skill routing suggestion: "${result.skill}"${detail}. Load its full instructions only if it helps with the current task.`,
    }],
    source: { kind: 'dsh-jev', form: 'notice', summary: boundContextSummary(`skill: ${result.skill}`) },
  }))
  runtime.log('info', 'skill suggestion injected', { skill: result.skill })
}
