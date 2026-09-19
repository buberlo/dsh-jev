import { describe, expect, it } from 'vitest'
import type { Fetch } from '@typesafe-ai/sdk'
import { JevError } from '../src/errors.js'
import { LiveTypeSafeProvider } from '../src/live-provider.js'
import { choice, noul } from '../src/primitives.js'

function jsonFetch(body: unknown, status = 200, capture?: { url?: string; init?: RequestInit }): Fetch {
  return async (url, init) => {
    if (capture !== undefined) {
      capture.url = url
      capture.init = init
    }
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }
}

const questions = { department: choice('Which team?', { billing: 'B', technical: 'T' }) }

describe('LiveTypeSafeProvider', () => {
  it('requires an explicit API key', () => {
    expect(() => new LiveTypeSafeProvider({ apiKey: '' })).toThrowError(JevError)
    expect(() => new LiveTypeSafeProvider({ apiKey: '   ' })).toThrowError(/explicit/)
  })

  it('sends the documented request shape and validates the reply', async () => {
    const capture: { url?: string; init?: RequestInit } = {}
    const provider = new LiveTypeSafeProvider({
      apiKey: 'test-key',
      fetch: jsonFetch({
        model: 'jev-1.13.0',
        answers: { department: { type: 'choice', choice: 'billing', confidence: 1, probabilities: { billing: 1, technical: 0 } } },
        usage: { input_tokens: 12, output_tokens: 3 },
      }, 200, capture),
    })
    const reply = await provider.ask({ state: 'ticket', questions })
    expect(reply.model).toBe('jev-1.13.0')
    expect(reply.answers.department.choice).toBe('billing')
    expect(capture.url).toBe('https://api.typesafe.ai/v1/systemone')
    const body = JSON.parse(String(capture.init?.body)) as Record<string, unknown>
    expect(body.model).toBe('jev-latest')
    expect(body.state).toBe('ticket')
    expect(body.questions).toMatchObject({ department: { type: 'choice' } })
    const headers = capture.init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer test-key')
  })

  it('rejects a structurally invalid reply as INVALID_RESPONSE', async () => {
    const provider = new LiveTypeSafeProvider({
      apiKey: 'test-key',
      fetch: jsonFetch({
        model: 'jev-1.13.0',
        answers: { department: { type: 'choice', choice: 'sales', confidence: 1, probabilities: { sales: 1 } } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    })
    await expect(provider.ask({ state: 'ticket', questions })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('maps an authentication failure', async () => {
    const provider = new LiveTypeSafeProvider({
      apiKey: 'bad-key',
      maxRetries: 0,
      fetch: jsonFetch({ error: { message: 'invalid key' } }, 401),
    })
    await expect(provider.ask({ state: 'ticket', questions })).rejects.toMatchObject({ code: 'AUTHENTICATION' })
  })

  it('maps a rate limit failure', async () => {
    let calls = 0
    const provider = new LiveTypeSafeProvider({
      apiKey: 'test-key',
      maxRetries: 0,
      fetch: async () => {
        calls += 1
        return new Response(JSON.stringify({ error: { message: 'slow down' } }), { status: 429, headers: { 'content-type': 'application/json' } })
      },
    })
    await expect(provider.ask({ state: 'ticket', questions })).rejects.toMatchObject({ code: 'RATE_LIMIT', retryable: true })
    expect(calls).toBe(1)
  })

  it('does not add a second retry loop: tries follow the SDK policy', async () => {
    let calls = 0
    const provider = new LiveTypeSafeProvider({
      apiKey: 'test-key',
      maxRetries: 1,
      fetch: async () => {
        calls += 1
        return new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500, headers: { 'content-type': 'application/json' } })
      },
    })
    await expect(provider.ask({ state: 'ticket', questions })).rejects.toMatchObject({ code: 'SERVER' })
    expect(calls).toBe(2)
  })

  it('maps caller cancellation to ABORTED', async () => {
    const provider = new LiveTypeSafeProvider({
      apiKey: 'test-key',
      maxRetries: 0,
      fetch: (_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }),
    })
    const controller = new AbortController()
    const pending = provider.ask({ state: 'ticket', questions }, { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('maps a per-attempt timeout', async () => {
    const provider = new LiveTypeSafeProvider({
      apiKey: 'test-key',
      timeoutMs: 20,
      maxRetries: 0,
      fetch: (_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }),
    })
    await expect(provider.ask({ state: 'ticket', questions })).rejects.toMatchObject({ code: 'TIMEOUT', retryable: true })
  })

  it('keeps noul answers free of an invented confidence', async () => {
    const provider = new LiveTypeSafeProvider({
      apiKey: 'test-key',
      fetch: jsonFetch({
        model: 'jev-1.13.0',
        answers: { q: { type: 'noul', noul: 0.8 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    })
    const reply = await provider.ask({ state: 's', questions: { q: noul('Q?') } })
    expect(reply.answers.q).toEqual({ type: 'noul', noul: 0.8 })
  })
})
