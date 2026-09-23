/**
 * Structured error vocabulary for the Jev decision core.
 *
 * @module jev-core/errors
 */

/** Stable failure classes a Jev decision can surface to its caller. */
export type JevErrorCode =
  | 'AUTHENTICATION'
  | 'PERMISSION'
  | 'RATE_LIMIT'
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'SERVER'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'CONNECTION'
  | 'INVALID_RESPONSE'
  | 'INVALID_CONFIG'
  | 'INCOMPLETE_INPUT'
  | 'OFF'
  | 'UNKNOWN'

/** One machine-readable validation violation gathered at the provider boundary. */
export interface JevViolation {
  /** Dotted location of the offending value, e.g. `answers.department.probabilities`. */
  readonly path: string
  /** What is wrong with the value. */
  readonly message: string
  /** The offending value, reduced to a short printable form. */
  readonly received?: unknown
}

/**
 * One typed Jev failure. Never carries an API key, raw request body, or raw
 * provider payload: `detail` only contains bounded, structural information.
 */
export class JevError extends Error {
  readonly code: JevErrorCode
  readonly retryable: boolean
  readonly detail: readonly JevViolation[]

  constructor(code: JevErrorCode, message: string, options: {
    retryable?: boolean
    detail?: readonly JevViolation[]
    cause?: unknown
  } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'JevError'
    this.code = code
    this.retryable = options.retryable ?? false
    this.detail = options.detail ?? []
  }
}

/** True when `value` is a {@link JevError} from this package instance. */
export function isJevError(value: unknown): value is JevError {
  return value instanceof JevError
}

/** Human-readable, bounded rendering of an unknown thrown value. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return '<unprintable error>'
  }
}
