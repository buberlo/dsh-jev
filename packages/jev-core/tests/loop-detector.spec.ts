import { describe, expect, it } from 'vitest'
import { LoopDetector } from '../src/loop-detector.js'
import { hashString, boundValue, stableStringify, isSensitiveKey } from '../src/redact.js'

describe('LoopDetector', () => {
  it('counts consecutive identical keys and reports the threshold', () => {
    const detector = new LoopDetector({ maxRepeats: 3, maxSubjects: 4 })
    expect(detector.observe('agent-a', 'k1')).toEqual({ count: 1, repeated: false })
    expect(detector.observe('agent-a', 'k1')).toEqual({ count: 2, repeated: false })
    expect(detector.observe('agent-a', 'k1')).toEqual({ count: 3, repeated: true })
  })

  it('resets the chain when the key changes', () => {
    const detector = new LoopDetector({ maxRepeats: 2, maxSubjects: 4 })
    detector.observe('agent-a', 'k1')
    expect(detector.observe('agent-a', 'k2')).toEqual({ count: 1, repeated: false })
    expect(detector.peek('agent-a', 'k1')).toBe(0)
  })

  it('keeps subjects independent', () => {
    const detector = new LoopDetector({ maxRepeats: 2, maxSubjects: 4 })
    detector.observe('agent-a', 'k1')
    expect(detector.observe('agent-b', 'k1')).toEqual({ count: 1, repeated: false })
  })

  it('evicts oldest subjects beyond the cap', () => {
    const detector = new LoopDetector({ maxRepeats: 2, maxSubjects: 2 })
    detector.observe('agent-a', 'k')
    detector.observe('agent-b', 'k')
    detector.observe('agent-c', 'k')
    expect(detector.size).toBe(2)
    expect(detector.peek('agent-a', 'k')).toBe(0)
  })

  it('validates its options', () => {
    expect(() => new LoopDetector({ maxRepeats: 1, maxSubjects: 1 })).toThrowError(TypeError)
    expect(() => new LoopDetector({ maxRepeats: 2, maxSubjects: 0 })).toThrowError(TypeError)
  })
})

describe('redact helpers', () => {
  it('matches sensitive field names case-insensitively', () => {
    expect(isSensitiveKey('API_KEY')).toBe(true)
    expect(isSensitiveKey('nestedToken')).toBe(true)
    expect(isSensitiveKey('username')).toBe(false)
  })

  it('redacts sensitive values and bounds strings', () => {
    const bounded = boundValue(
      { user: 'a'.repeat(50), apiKey: 'secret', list: [1, 2, 3, 4] },
      { maxStringChars: 10, maxArrayItems: 2, maxDepth: 3, redactKeys: ['apikey'] },
    ) as Record<string, unknown>
    expect(bounded.apiKey).toBe('[redacted]')
    expect(String(bounded.user)).toHaveLength(10 + '…[truncated]'.length)
    expect((bounded.list as unknown[]).length).toBe(3)
  })

  it('handles cycles without throwing', () => {
    const cyclic: Record<string, unknown> = { name: 'x' }
    cyclic.self = cyclic
    expect(() => boundValue(cyclic, { maxStringChars: 5, maxArrayItems: 3, maxDepth: 3, redactKeys: [] })).not.toThrow()
  })

  it('stableStringify sorts keys so equal objects hash equally', () => {
    const options = { maxStringChars: 100, maxArrayItems: 10, maxDepth: 3, redactKeys: [] }
    expect(stableStringify({ b: 1, a: 2 }, options)).toBe(stableStringify({ a: 2, b: 1 }, options))
    expect(hashString('abc')).toBe(hashString('abc'))
    expect(hashString('abc')).not.toBe(hashString('abd'))
  })
})
