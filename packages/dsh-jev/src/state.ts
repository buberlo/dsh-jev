/**
 * Per-agent plugin state.
 *
 * State is keyed by the exact agent object and is torn down with
 * `agent/disposed`: the selection restriction is lifted, in-flight requests
 * are aborted, and loop counters are dropped. Nothing is shared between agents.
 *
 * @module dsh-jev/state
 */

import type { Agent } from '@deepseek-ai/dsh-agent'

/** The bounded turn snapshot an asynchronous decision is bound to. */
export interface Snapshot {
  /** Monotonic within one agent; every turn/catalog change advances it. */
  version: number
  /** Bounded task text captured from the admitted user message. */
  task: string
  /** Bounded step label. */
  step: string
  /** Harness turn number, when known. */
  turn: number
}

/** One agent's live plugin state. */
export class AgentState {
  readonly agent: Agent
  #snapshot: Snapshot = { version: 0, task: '', step: '', turn: -1 }
  #selectionDisposer: (() => void) | undefined
  readonly #inFlight = new Set<AbortController>()
  /** Snapshot version whose skill hint was already injected. */
  skillHintVersion = -1
  /** Turn whose skill hint was already injected (one hint per turn). */
  skillHintTurn = -1
  /** Catalog version the last selection was computed against. */
  selectionCatalogVersion = -1
  /**
   * Whether this agent already logged the empty selection-catalog warning.
   * One warning per agent session, so later steps of the same turn stay quiet.
   */
  warnedEmptySelectionCatalog = false

  constructor(agent: Agent) {
    this.agent = agent
  }

  /** Current snapshot (immutable view). */
  get snapshot(): Snapshot {
    return this.#snapshot
  }

  /** Number of in-flight provider requests for this agent. */
  get inFlightCount(): number {
    return this.#inFlight.size
  }

  /** Whether a selection restriction is currently applied. */
  get hasSelectionRestriction(): boolean {
    return this.#selectionDisposer !== undefined
  }

  /**
   * Advance the snapshot for one turn boundary.
   * @param input - task, step, and turn of the new boundary.
   * @returns the new snapshot.
   */
  updateSnapshot(input: { task: string; step: string; turn: number }): Snapshot {
    this.#snapshot = {
      version: this.#snapshot.version + 1,
      task: input.task,
      step: input.step,
      turn: input.turn,
    }
    return this.#snapshot
  }

  /** Register an in-flight controller (aborted on disposal). */
  addInFlight(controller: AbortController): void {
    this.#inFlight.add(controller)
  }

  /** Unregister an in-flight controller. */
  removeInFlight(controller: AbortController): void {
    this.#inFlight.delete(controller)
  }

  /**
   * Apply a new selection restriction, replacing any previous one so the
   * visible tool set is always recomputed from the unrestricted catalog
   * (the defined recovery path for a bad selection).
   * @param apply - caller that registers the restriction and returns its disposer.
   * @returns true when the restriction was applied.
   */
  applySelection(apply: () => () => void): boolean {
    this.liftSelection()
    const disposer = apply()
    this.#selectionDisposer = disposer
    return true
  }

  /** Lift the current selection restriction, if any. */
  liftSelection(): void {
    const disposer = this.#selectionDisposer
    this.#selectionDisposer = undefined
    if (disposer !== undefined) {
      try {
        disposer()
      } catch {
        // An already-disposed scope must not break the next turn.
      }
    }
  }

  /** Abort every in-flight request and lift the restriction. */
  dispose(): void {
    for (const controller of this.#inFlight) controller.abort(new Error('agent disposed'))
    this.#inFlight.clear()
    this.liftSelection()
  }
}
