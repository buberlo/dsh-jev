/**
 * Install proof for the vendored TypeSafe skill.
 *
 * Uses the real `@deepseek-ai/dsh-skill-filesystem` provider against the
 * checked-in `.agents/skills` directory: discovery, catalog metadata, and the
 * plugin's routing/injection path are exercised end to end. If the vendored
 * skill disappears or its frontmatter stops parsing, this suite fails.
 *
 * See `docs/skills.md` for provenance and the update procedure.
 */

import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry, { isModelInvocable } from '@deepseek-ai/dsh-skill'
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import JevPlugin from '../src/index.js'
import { ScriptedAdapter, textTurn } from './helpers/scripted-adapter.js'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    try {
      await ctx.fiber.dispose()
    } catch {
      // Already disposed by the test.
    }
  }
})

const skillsRoot = fileURLToPath(new URL('../../../.agents/skills', import.meta.url))

/** Mirror the adapter's catalog projection so the assertion matches production. */
async function catalogProjection(ctx: Context): Promise<Array<{ name: string; description: string; whenToUse?: string }>> {
  const catalog = await ctx.skills.list()
  return catalog.filter(isModelInvocable).map(skill => ({
    name: skill.name,
    description: skill.description,
    ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
  }))
}

async function mountWithVendoredSkills() {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(SkillFilesystem, {
    includeDefaultRoots: false,
    customSkillDirs: [skillsRoot],
    watch: false,
  })
  await ctx.plugin(JevPlugin, {
    provider: 'mock',
    mode: 'enforce',
    selection: { enabled: false },
    assessment: { enabled: false },
    skills: { enabled: true, injectHint: true },
    mock: {
      answers: {
        needs_skill: { noul: 0.95 },
        skill: { choice: { choice: 'typesafe-ai', confidence: 1 } },
      },
    },
  })
  const adapter = new ScriptedAdapter()
  ctx.llm.registerAdapter(['scripted'], adapter)
  const harness = await mountAgentLoopTestHarness(ctx)
  return { ctx, adapter, harness }
}

describe('vendored TypeSafe skill', () => {
  it('is discovered by the real filesystem provider with valid metadata', async () => {
    const { ctx } = await mountWithVendoredSkills()
    const projection = await catalogProjection(ctx)
    const skill = projection.find(candidate => candidate.name === 'typesafe-ai')
    expect(skill).toBeDefined()
    expect(skill?.description).toContain('Build AI-powered software with TypeSafe')
    // The parser must not reject the extra `license` frontmatter key.
    expect(skill?.whenToUse).toBeUndefined()
  })

  it('is routed by the plugin and injected as a bounded hint without its body', async () => {
    const { ctx, adapter, harness } = await mountWithVendoredSkills()
    const agent = await harness.create(SessionId('skill-agent'), { provider: 'scripted', model: 'scripted-1' })
    adapter.enqueue('skill-agent', textTurn('done'))
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Add a TypeSafe Jev classifier to our request router' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    const texts = adapter.messageTexts.flat()
    expect(texts.some(text => text.includes('Skill routing suggestion: "typesafe-ai"'))).toBe(true)
    // The body must not be injected by the routing hint.
    expect(texts.some(text => text.includes('## Read the live docs'))).toBe(false)
    expect(ctx.jev.stats.selections).toBe(0)
  })
})
