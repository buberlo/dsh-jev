/**
 * Controller for the Jev configuration page: binds the `jev` settings scope
 * and projects it into the plain data + callbacks face the card component
 * receives. The component owns its local draft state; this controller owns
 * every write.
 *
 * @module dsh-jev/client/jev-card-controller
 */

import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'

/** The subset of the `jev` section this card reads and edits. */
export interface JevSettings {
  provider?: 'mock' | 'live'
  mode?: 'off' | 'shadow' | 'enforce'
  selection?: { enabled?: boolean }
  assessment?: { enabled?: boolean }
  loopDetection?: { enabled?: boolean }
  skills?: { enabled?: boolean }
  modelRouting?: { enabled?: boolean }
}

/** One feature toggle the card renders. */
export interface JevFeatureState {
  /** Settings field path, e.g. `selection.enabled`. */
  readonly field: string
  readonly enabled: boolean
}

/** What the card renders. Plain JSON-compatible data and callbacks only. */
export interface JevCardFace {
  readonly snapshot: {
    readonly status: 'loading' | 'ready' | 'unavailable'
    readonly writable: boolean
    readonly provider: 'mock' | 'live'
    readonly mode: 'off' | 'shadow' | 'enforce'
    readonly features: readonly JevFeatureState[]
  }
  /** Store one field value through the settings scope. */
  readonly setField: (field: string, value: unknown) => Promise<void>
}

const FEATURE_FIELDS: readonly string[] = [
  'selection.enabled',
  'assessment.enabled',
  'loopDetection.enabled',
  'skills.enabled',
  'modelRouting.enabled',
]

/** Read a dotted path from the settings section. */
function readBoolean(value: unknown, path: string, fallback: boolean): boolean {
  let current: unknown = value
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null) return fallback
    current = (current as Record<string, unknown>)[segment]
  }
  return typeof current === 'boolean' ? current : fallback
}

/** Bridges the `jev` settings scope onto the card's inject face. */
export class JevCardController {
  readonly #scope: SettingsScope<JevSettings>

  /** @param scope - the bound settings scope for the `jev` namespace. */
  constructor(scope: SettingsScope<JevSettings>) {
    this.#scope = scope
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the current snapshot projection and the write callback.
   */
  inject(): JevCardFace {
    const snapshot = this.#scope.getSnapshot()
    const value = snapshot.value
    return {
      snapshot: {
        status: snapshot.status,
        writable: snapshot.writable,
        provider: value?.provider ?? 'mock',
        mode: value?.mode ?? 'shadow',
        features: FEATURE_FIELDS.map((field): JevFeatureState => ({
          field,
          enabled: readBoolean(value, field, true),
        })),
      },
      setField: async (field, next) => {
        await this.#scope.set(field, next)
      },
    }
  }
}
