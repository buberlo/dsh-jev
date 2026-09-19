/**
 * Bounded concurrency and whole-call time budgets.
 *
 * The live TypeSafe SDK owns HTTP retries; this module only bounds how many
 * requests run at once and how long one logical evaluation may take in total.
 * There is deliberately no second retry mechanism here.
 *
 * @module jev-core/limits
 */

/** A simple FIFO semaphore for in-process concurrency limiting. */
export class Semaphore {
  readonly #max: number
  #active = 0
  readonly #waiters: Array<() => void> = []

  constructor(max: number) {
    if (!Number.isInteger(max) || max < 1) throw new TypeError('Semaphore max must be a positive integer')
    this.#max = max
  }

  /** Current number of held permits. */
  get active(): number {
    return this.#active
  }

  /** Number of queued acquirers. */
  get pending(): number {
    return this.#waiters.length
  }

  /** Acquire one permit, waiting in FIFO order. */
  async acquire(): Promise<() => void> {
    if (this.#active < this.#max) {
      this.#active += 1
      return this.#release()
    }
    await new Promise<void>((resolve) => { this.#waiters.push(resolve) })
    this.#active += 1
    return this.#release()
  }

  #release(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.#active -= 1
      const next = this.#waiters.shift()
      if (next) next()
    }
  }
}

/** Combine any number of abort signals into one that aborts when any input does. */
export function combineSignals(signals: readonly (AbortSignal | undefined)[]): AbortSignal {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined)
  if (present.length === 0) return new AbortController().signal
  if (present.length === 1) return present[0] as AbortSignal
  const controller = new AbortController()
  const abort = (reason: unknown): void => controller.abort(reason)
  for (const signal of present) {
    if (signal.aborted) {
      abort(signal.reason)
      break
    }
    signal.addEventListener('abort', () => abort(signal.reason), { once: true })
  }
  return controller.signal
}

/** A combined signal plus the exact cleanup that removes its listeners. */
export interface BudgetSignal {
  readonly signal: AbortSignal
  /** Whether the budget (not the caller) fired. */
  readonly expired: () => boolean
  readonly dispose: () => void
}

/**
 * Build a signal that aborts when the caller aborts or the budget elapses.
 * @param signal - caller-owned cancellation, optional.
 * @param budgetMs - whole-call budget; non-positive budgets are invalid.
 * @returns the combined signal, an expiry probe, and cleanup.
 */
export function withBudget(signal: AbortSignal | undefined, budgetMs: number): BudgetSignal {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new TypeError('budgetMs must be a positive number')
  const controller = new AbortController()
  let expired = false
  const onAbort = (): void => controller.abort(signal?.reason)
  if (signal !== undefined) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => {
    expired = true
    controller.abort(new Error(`jev budget of ${budgetMs}ms elapsed`))
  }, budgetMs)
  return {
    signal: controller.signal,
    expired: () => expired,
    dispose: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    },
  }
}
