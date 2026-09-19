/**
 * Deterministic System-2 test adapter for DSH loop tests.
 *
 * The adapter replays a scripted list of raw stream chunks per session. It is
 * a test double for an LLM provider, not a Jev provider: the Jev side of every
 * test stays on `MockJevProvider`.
 *
 * @module dsh-jev/tests/helpers/scripted-adapter
 */

import { LlmAdapter, type GenerateOptions, type LlmModelInfo, type StreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'

const USAGE: TokenUsage = { inputTokens: 12, outputTokens: 4 }

/** One assistant text turn. */
export function textTurn(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: USAGE },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** One assistant tool-call turn. */
export function toolTurn(name: string, args: unknown, id = 'call-1'): StreamChunk[] {
  const raw = JSON.stringify(args)
  const callId = ToolCallId(id)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: raw },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: raw } },
    { type: 'usage', usage: USAGE },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** Scripted replay adapter; unknown sessions answer with one text turn. */
export class ScriptedAdapter extends LlmAdapter {
  readonly #scripts = new Map<string, StreamChunk[][]>()
  readonly #cursors = new Map<string, number>()
  /** Model calls in order, as `<session>#<index>`. */
  readonly calls: string[] = []
  /** Model ids requested, in call order. */
  readonly modelsSeen: string[] = []
  /** Flattened text of every request's messages, in call order. */
  readonly messageTexts: string[][] = []

  /** Queue turns for one session id (or `default`). */
  enqueue(sessionId: string, ...turns: StreamChunk[][]): this {
    this.#scripts.set(sessionId, [...(this.#scripts.get(sessionId) ?? []), ...turns])
    return this
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([
      { provider, id: 'scripted-1', name: 'Scripted One' },
      { provider, id: 'scripted-2', name: 'Scripted Two' },
    ])
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.modelsSeen.push(options.model)
    this.messageTexts.push(options.messages.flatMap(message =>
      message.content.filter(block => block.type === 'text').map(block => block.type === 'text' ? block.text : ''),
    ))
    // Auxiliary calls (title, compaction) never consume the conversation script.
    if (options.purpose !== undefined) {
      yield* textTurn('auxiliary')
      return
    }
    const key = options.sessionId === undefined ? 'default' : String(options.sessionId)
    const index = this.#cursors.get(key) ?? 0
    this.#cursors.set(key, index + 1)
    this.calls.push(`${key}#${index}`)
    const turn = this.#scripts.get(key)?.[index]
    if (turn === undefined) {
      yield* textTurn('(no scripted turn)')
      return
    }
    for (const chunk of turn) {
      if (options.signal?.aborted) return
      yield chunk
    }
  }
}
