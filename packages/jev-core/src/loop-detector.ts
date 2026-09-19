/**
 * Bounded repetition detector.
 *
 * Counts consecutive identical calls per subject (the harness keys by agent).
 * It is deliberately small: one chain per subject, a hard agent cap, and no
 * retry or escalation logic of its own. Consequence is left to the caller.
 *
 * @module jev-core/loop-detector
 */

/** Construction options. */
export interface LoopDetectorOptions {
  /** Repetitions of the same key that count as a loop (>= 2). */
  readonly maxRepeats: number
  /** Maximum simultaneously tracked subjects; oldest is evicted first. */
  readonly maxSubjects: number
}

/** One observation result. */
export interface LoopObservation {
  /** Number of consecutive identical observations for this subject. */
  readonly count: number
  /** Whether `count` reached the configured maximum. */
  readonly repeated: boolean
}

/** Counts consecutive equal call keys per subject. */
export class LoopDetector {
  readonly #maxRepeats: number
  readonly #maxSubjects: number
  readonly #chains = new Map<unknown, { key: string; count: number }>()

  constructor(options: LoopDetectorOptions) {
    if (!Number.isInteger(options.maxRepeats) || options.maxRepeats < 2) {
      throw new TypeError('maxRepeats must be an integer >= 2')
    }
    if (!Number.isInteger(options.maxSubjects) || options.maxSubjects < 1) {
      throw new TypeError('maxSubjects must be a positive integer')
    }
    this.#maxRepeats = options.maxRepeats
    this.#maxSubjects = options.maxSubjects
  }

  /** Number of tracked subjects. */
  get size(): number {
    return this.#chains.size
  }

  /** Current consecutive count for one subject/key without advancing it. */
  peek(subject: unknown, key: string): number {
    const chain = this.#chains.get(subject)
    return chain !== undefined && chain.key === key ? chain.count : 0
  }

  /**
   * Record one observation and return the new run length.
   * @param subject - the counting subject (e.g. an agent).
   * @param key - stable call identity (tool id plus bounded arguments).
   * @returns the run length and whether it reached the threshold.
   */
  observe(subject: unknown, key: string): LoopObservation {
    const chain = this.#chains.get(subject)
    const count = chain !== undefined && chain.key === key ? chain.count + 1 : 1
    if (chain === undefined && this.#chains.size >= this.#maxSubjects) {
      const oldest = this.#chains.keys().next()
      if (!oldest.done) this.#chains.delete(oldest.value)
    }
    this.#chains.delete(subject)
    this.#chains.set(subject, { key, count })
    return { count, repeated: count >= this.#maxRepeats }
  }

  /** Forget one subject's chain. */
  reset(subject: unknown): void {
    this.#chains.delete(subject)
  }

  /** Forget every chain. */
  clear(): void {
    this.#chains.clear()
  }
}
