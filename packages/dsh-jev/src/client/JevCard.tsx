/**
 * The Jev configuration page in the DSH web client.
 *
 * Rendered by the Plugins page inside this bundle's page (`plugins.bundle.config`,
 * keyed by the bundle package name). The card explains what Jev does in the
 * agent loop and edits the safe subset of the plugin configuration (mode and
 * feature toggles) through the host settings scope. Provider and API key stay
 * in `cordis.yml` — the key is a secret and is never displayed.
 *
 * @module dsh-jev/client/JevCard
 */

import { useState, type CSSProperties, type ReactNode } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { JevCardFace } from './jev-card-controller.js'

/** Props the renderer binds for the bundle's configuration page. */
export type JevCardProps =
  PropsRuntime<'plugins.bundle.config'>
  & PropsLocale<'settings.jev'>
  & InjectFace<JevCardFace>

const MODES = ['off', 'shadow', 'enforce'] as const

const styles = {
  root: { display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '640px', fontSize: '13px', lineHeight: 1.5 } satisfies CSSProperties,
  intro: { color: 'var(--dsw-alias-label-secondary, #888)', margin: 0 } satisfies CSSProperties,
  row: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } satisfies CSSProperties,
  label: { fontWeight: 600, minWidth: '86px' } satisfies CSSProperties,
  chip: { padding: '4px 10px', borderRadius: '999px', border: '1px solid var(--dsw-alias-border-l2, #ccc)', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '13px' } satisfies CSSProperties,
  chipActive: { background: 'var(--dsw-alias-brand-primary, #4d6bfe)', borderColor: 'transparent', color: '#fff' } satisfies CSSProperties,
  hint: { color: 'var(--dsw-alias-label-secondary, #888)', margin: 0 } satisfies CSSProperties,
  feature: { display: 'flex', gap: '8px', alignItems: 'flex-start' } satisfies CSSProperties,
  status: { color: 'var(--dsw-alias-label-secondary, #888)' } satisfies CSSProperties,
  error: { color: 'var(--dsw-alias-state-error-primary, #d33)' } satisfies CSSProperties,
} as const

/**
 * Render the bundle's configuration page.
 * @param props - view, locale copy, and the controller face.
 * @returns the summary one-liner or the configuration card.
 */
export function JevCard(props: JevCardProps): ReactNode {
  const { t } = props
  const [mode, setMode] = useState(props.snapshot.mode)
  const [provider, setProvider] = useState(props.snapshot.provider)
  const [apiKey, setApiKey] = useState('')
  const [features, setFeatures] = useState<Record<string, boolean>>(() => Object.fromEntries(
    props.snapshot.features.map(feature => [feature.field, feature.enabled]),
  ))
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  const [error, setError] = useState('')

  if (props.view === 'summary') return t('summary')

  const persist = (field: string, value: unknown): void => {
    setState('saving')
    setError('')
    props.setField(field, value).then(
      () => { setState('saved') },
      (reason: unknown) => {
        setState('failed')
        setError(reason instanceof Error ? reason.message : String(reason))
      },
    )
  }

  const status = props.snapshot.status
  const disabled = !props.snapshot.writable || state === 'saving'

  if (status === 'loading' || status === 'unavailable') {
    return (
      <div style={styles.root}>
        <p style={styles.intro}>{t('intro')}</p>
        <p style={styles.status}>{status === 'loading' ? t('statusLoading') : t('statusUnavailable')}</p>
      </div>
    )
  }

  const saveKey = (): void => {
    const value = apiKey.trim()
    if (value.length === 0) return
    persist('apiKey', value)
    setApiKey('')
  }

  return (
    <div style={styles.root}>
      <p style={styles.intro}>{t('intro')}</p>
      <p style={styles.status}>{t('writable')}</p>

      <div style={styles.row}>
        <span style={styles.label}>{t('provider')}</span>
        {(['mock', 'live'] as const).map(candidate => (
          <button
            key={candidate}
            type="button"
            disabled={disabled}
            style={candidate === provider ? { ...styles.chip, ...styles.chipActive } : styles.chip}
            onClick={() => {
              setProvider(candidate)
              persist('provider', candidate)
            }}
          >
            {candidate === 'mock' ? 'mock' : 'live'}
          </button>
        ))}
      </div>
      <p style={styles.hint}>{t(provider === 'live' ? 'providerHintLive' : 'providerHintMock')}</p>

      {provider === 'live' ? (
        <div style={styles.row}>
          <span style={styles.label}>{t('apiKey')}</span>
          <input
            type="password"
            value={apiKey}
            disabled={disabled}
            placeholder={t('apiKeyPlaceholder')}
            autoComplete="off"
            style={{ flex: '1 1 260px', padding: '4px 8px' }}
            onChange={(event) => { setApiKey(event.target.value) }}
          />
          <button type="button" disabled={disabled || apiKey.trim().length === 0} style={styles.chip} onClick={saveKey}>
            {t('setKey')}
          </button>
        </div>
      ) : null}
      {provider === 'live' ? <p style={styles.hint}>{t('apiKeyHint')}</p> : null}

      <div style={styles.row}>
        <span style={styles.label}>{t('mode')}</span>
        {MODES.map(candidate => (
          <button
            key={candidate}
            type="button"
            disabled={disabled}
            style={candidate === mode ? { ...styles.chip, ...styles.chipActive } : styles.chip}
            onClick={() => {
              setMode(candidate)
              persist('mode', candidate)
            }}
          >
            {t(candidate === 'off' ? 'modeOff' : candidate === 'shadow' ? 'modeShadow' : 'modeEnforce')}
          </button>
        ))}
      </div>
      <p style={styles.hint}>
        {t(mode === 'off' ? 'modeHintOff' : mode === 'shadow' ? 'modeHintShadow' : 'modeHintEnforce')}
      </p>

      <div>
        <div style={{ ...styles.label, marginBottom: '6px' }}>{t('features')}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {props.snapshot.features.map(feature => (
            <label key={feature.field} style={styles.feature}>
              <input
                type="checkbox"
                checked={features[feature.field] ?? false}
                disabled={disabled}
                onChange={(event) => {
                  const next = event.target.checked
                  setFeatures(current => ({ ...current, [feature.field]: next }))
                  persist(feature.field, next)
                }}
              />
              <span>
                {t(featureFieldLabel(feature.field))}
                {' '}
                <code style={styles.hint}>{feature.field}</code>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div style={styles.row}>
        <button type="button" disabled={disabled} style={styles.chip} onClick={() => { setState('saved') }}>
          {t('save')}
        </button>
        <span style={state === 'failed' ? styles.error : styles.status}>
          {state === 'saving' ? t('saving') : state === 'saved' ? t('saved') : ''}
          {state === 'failed' ? `${t('failed')}${error}` : ''}
        </span>
      </div>
    </div>
  )
}

function featureFieldLabel(field: string): 'featureSelection' | 'featureAssessment' | 'featureLoopDetection' | 'featureSkills' | 'featureModelRouting' {
  switch (field) {
    case 'selection.enabled': return 'featureSelection'
    case 'assessment.enabled': return 'featureAssessment'
    case 'loopDetection.enabled': return 'featureLoopDetection'
    case 'skills.enabled': return 'featureSkills'
    default: return 'featureModelRouting'
  }
}
