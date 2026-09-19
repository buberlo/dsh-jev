/**
 * Bounded, deterministic redaction helpers.
 *
 * Redaction is an additional measure, not guaranteed anonymization: it keeps
 * obviously sensitive fields and oversized payloads out of provider requests
 * and logs. Callers stay responsible for what they pass in.
 *
 * @module jev-core/redact
 */

/** Default field-name fragments considered sensitive (case-insensitive, substring match). */
export const DEFAULT_REDACT_KEYS: readonly string[] = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'authorization',
  'cookie',
  'credential',
  'private_key',
  'access_key',
  'session_key',
]

const REDACTED = '[redacted]'
const TRUNCATED = '…[truncated]'

/** Options shared by the bounding helpers. */
export interface BoundOptions {
  /** Maximum characters kept from one string. */
  readonly maxStringChars: number
  /** Maximum array entries kept. */
  readonly maxArrayItems: number
  /** Maximum object keys kept; defaults to at least 64. */
  readonly maxObjectKeys?: number
  /** Maximum object depth walked. */
  readonly maxDepth: number
  /** Field-name fragments whose values are replaced. */
  readonly redactKeys: readonly string[]
}

/** Whether a field name matches one of the redaction fragments. */
export function isSensitiveKey(key: string, redactKeys: readonly string[] = DEFAULT_REDACT_KEYS): boolean {
  const lower = key.toLowerCase()
  return redactKeys.some(fragment => lower.includes(fragment))
}

function boundString(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}${TRUNCATED}`
}

/**
 * Produce a bounded, redacted deep copy of one JSON-ish value. Cycles become
 * `"[circular]"`; non-JSON leaves are stringified and bounded. The function is
 * total: it never throws on hostile input.
 * @param value - the value to bound.
 * @param options - bounds and redaction keys.
 * @returns a fresh, bounded value.
 */
export function boundValue(value: unknown, options: BoundOptions): unknown {
  const seen = new WeakSet<object>()
  const walk = (current: unknown, depth: number): unknown => {
    if (current === null || current === undefined) return current
    if (typeof current === 'string') return boundString(current, options.maxStringChars)
    if (typeof current === 'number') return Number.isFinite(current) ? current : String(current)
    if (typeof current === 'boolean') return current
    if (typeof current === 'bigint') return boundString(current.toString(), options.maxStringChars)
    if (typeof current === 'function' || typeof current === 'symbol') return `[${typeof current}]`
    if (depth >= options.maxDepth) return '[depth limit]'
    if (typeof current === 'object') {
      if (seen.has(current)) return '[circular]'
      seen.add(current)
      if (Array.isArray(current)) {
        const items = current.slice(0, options.maxArrayItems).map(item => walk(item, depth + 1))
        if (current.length > options.maxArrayItems) items.push(`[${current.length - options.maxArrayItems} more]`)
        return items
      }
      const source = current as Record<string, unknown>
      const out: Record<string, unknown> = {}
      const maxKeys = options.maxObjectKeys ?? Math.max(64, options.maxArrayItems)
      let entries = 0
      for (const key of Object.keys(source)) {
        if (entries >= maxKeys) {
          out['[truncated]'] = `${Object.keys(source).length - entries} more key(s)`
          break
        }
        out[key] = isSensitiveKey(key, options.redactKeys)
          ? REDACTED
          : walk(source[key], depth + 1)
        entries += 1
      }
      return out
    }
    return String(current)
  }
  return walk(value, 0)
}

/**
 * Deterministically serialize a value with sorted object keys, so equal
 * argument objects hash identically. Bounded via {@link boundValue} first.
 * @param value - the value to serialize.
 * @param options - bounds and redaction keys.
 * @returns a stable JSON string.
 */
export function stableStringify(value: unknown, options: BoundOptions): string {
  const bounded = boundValue(value, options)
  const walk = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(walk)
    if (current !== null && typeof current === 'object') {
      const source = current as Record<string, unknown>
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(source).sort()) out[key] = walk(source[key])
      return out
    }
    return current
  }
  return JSON.stringify(walk(bounded)) ?? 'null'
}

/**
 * Small deterministic 64-bit-ish FNV-1a hash rendered as hex. Not a
 * cryptographic hash; used only for stable, local call signatures.
 * @param input - the string to hash.
 * @returns 16 hex characters.
 */
export function hashString(input: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index)
    h1 ^= code
    h1 = Math.imul(h1, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ code, 0x85ebca6b) >>> 0
    h2 = ((h2 << 13) | (h2 >>> 19)) >>> 0
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}
