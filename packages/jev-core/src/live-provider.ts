/**
 * Live Jev provider backed by the official `@typesafe-ai/sdk`.
 *
 * The SDK owns HTTP retries and per-attempt timeouts; this provider adds no
 * second retry loop. Live access is never implicit: an API key must be passed
 * explicitly by the caller, and the default log level is `off` so request
 * bodies never reach application logs by accident.
 *
 * @module jev-core/live-provider
 */

import {
  APIConnectionError,
  APIUserAbortError,
  APITimeoutError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  TypeSafeClient,
  TypeSafeError,
  UnprocessableEntityError,
  type Fetch,
  type LogLevel,
  type Questions,
} from '@typesafe-ai/sdk'
import { JevError } from './errors.js'
import type { JevCallOptions, JevProvider, JevProviderReply, JevProviderRequest } from './types.js'
import { validateReply } from './validate.js'

/** Configuration for the live provider. */
export interface LiveTypeSafeProviderConfig {
  /** TypeSafe API key. Required and explicit; the SDK's environment fallback is not used. */
  readonly apiKey: string
  /** Default model; omitted means the documented `jev-latest` alias. */
  readonly model?: string
  /** API root override, for proxies or on-prem gateways. */
  readonly baseURL?: string
  /** Per-attempt timeout in milliseconds passed to the SDK. */
  readonly timeoutMs?: number
  /** SDK-owned retry count after the initial attempt. No provider-level retries are added. */
  readonly maxRetries?: number
  /**
   * SDK log level. Defaults to `off`: at `debug` the SDK logs request bodies,
   * which may contain application state.
   */
  readonly logLevel?: LogLevel
  /** Custom fetch implementation (transport configuration or tests). */
  readonly fetch?: Fetch
}

/** The documented default model alias, used only as an explicit SDK default. */
export const DEFAULT_LIVE_MODEL = 'jev-latest'

/** Live provider: wraps {@link TypeSafeClient} and validates every reply. */
export class LiveTypeSafeProvider implements JevProvider {
  readonly kind = 'live' as const
  readonly #client: TypeSafeClient
  readonly #timeoutMs: number | undefined

  constructor(config: LiveTypeSafeProviderConfig) {
    if (typeof config.apiKey !== 'string' || config.apiKey.trim().length === 0) {
      throw new JevError('INVALID_CONFIG', 'live provider requires an explicit, non-empty apiKey')
    }
    this.#timeoutMs = config.timeoutMs
    this.#client = new TypeSafeClient({
      apiKey: config.apiKey,
      ...(config.baseURL === undefined ? {} : { baseURL: config.baseURL }),
      defaultModel: config.model ?? DEFAULT_LIVE_MODEL,
      logLevel: config.logLevel ?? 'off',
      ...(config.timeoutMs === undefined ? {} : { timeout: config.timeoutMs }),
      retry: { maxRetries: config.maxRetries ?? 1 },
      ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
    })
  }

  /** The model alias/id this provider defaults to. */
  get defaultModel(): string {
    return this.#client.defaultModel
  }

  async ask<Q extends Questions>(
    request: JevProviderRequest<Q>,
    options: JevCallOptions = {},
  ): Promise<JevProviderReply<Q>> {
    try {
      const timeout = options.timeoutMs ?? this.#timeoutMs
      const result = await this.#client.systemOne(
        {
          state: request.state,
          questions: request.questions,
          ...(request.model === undefined ? {} : { model: request.model }),
        },
        {
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(timeout === undefined ? {} : { timeout }),
        },
      )
      return validateReply(request, result)
    } catch (error) {
      if (error instanceof JevError) throw error
      throw mapTypeSafeError(error)
    }
  }
}

/** Map SDK error classes onto the core's stable failure vocabulary. */
export function mapTypeSafeError(error: unknown): JevError {
  if (error instanceof APIUserAbortError) {
    return new JevError('ABORTED', 'TypeSafe request was aborted', { cause: error })
  }
  if (error instanceof APITimeoutError) {
    return new JevError('TIMEOUT', 'TypeSafe request timed out', { retryable: true, cause: error })
  }
  if (error instanceof APIConnectionError) {
    return new JevError('CONNECTION', 'TypeSafe connection failed', { retryable: true, cause: error })
  }
  if (error instanceof AuthenticationError) {
    return new JevError('AUTHENTICATION', 'TypeSafe rejected the API key', { cause: error })
  }
  if (error instanceof PermissionDeniedError) {
    return new JevError('PERMISSION', 'TypeSafe denied access for this key', { cause: error })
  }
  if (error instanceof RateLimitError) {
    return new JevError('RATE_LIMIT', 'TypeSafe rate limit reached', { retryable: true, cause: error })
  }
  if (error instanceof BadRequestError) {
    return new JevError('BAD_REQUEST', 'TypeSafe rejected the request as invalid', { cause: error })
  }
  if (error instanceof UnprocessableEntityError) {
    return new JevError('BAD_REQUEST', 'TypeSafe could not process the request', { cause: error })
  }
  if (error instanceof NotFoundError) {
    return new JevError('NOT_FOUND', 'TypeSafe model or endpoint not found', { cause: error })
  }
  if (error instanceof InternalServerError) {
    return new JevError('SERVER', 'TypeSafe reported a server error', { retryable: true, cause: error })
  }
  if (error instanceof TypeSafeError) {
    return new JevError('UNKNOWN', `TypeSafe SDK error: ${error.message}`, { cause: error })
  }
  const message = error instanceof Error ? error.message : String(error)
  return new JevError('UNKNOWN', `unexpected provider error: ${message}`, { cause: error })
}
