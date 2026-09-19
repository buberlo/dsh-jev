// @vitest-environment jsdom
/**
 * Browser-half coverage for the Jev configuration card.
 *
 * Note: the published `@deepseek-ai/dsh-client-test-runtime@0.1.6-alpha.2`
 * imports `dsh-client-ui-renderer/src/...` paths that the published renderer
 * does not ship, so the slot bench cannot be loaded from npm at this version
 * (recorded in docs/upstream-compatibility.md). The test therefore exercises
 * the same layers directly: `apply()` against a recording fake context for the
 * registration wiring, and the real component with the real controller for the
 * interactions.
 */

import { act } from '@testing-library/react'
import { render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import * as client from '../src/client/index.js'
import { JevCardController, type JevSettings } from '../src/client/jev-card-controller.js'
import { JevCard } from '../src/client/JevCard.js'
import { en } from '../src/client/locales.js'

interface RegisteredCard {
  readonly options: { name: string; key: string; locale?: string }
  readonly component: unknown
}

function fakeScope(initial: JevSettings): {
  scope: SettingsScope<JevSettings>
  set: ReturnType<typeof vi.fn>
} {
  let snapshot: SettingsScopeSnapshot<JevSettings> = {
    status: 'ready',
    value: initial,
    base: initial,
    user: {},
    revision: 1,
    writable: true,
    mode: 'host',
  }
  const set = vi.fn(async (field: string, value: unknown) => {
    const [head, tail] = field.split('.')
    if (tail === undefined) {
      snapshot = { ...snapshot, value: { ...snapshot.value, [head as keyof JevSettings]: value } as JevSettings }
    } else {
      const section = (snapshot.value?.[head as keyof JevSettings] ?? {}) as Record<string, unknown>
      snapshot = {
        ...snapshot,
        value: { ...snapshot.value, [head]: { ...section, [tail]: value } } as JevSettings,
      }
    }
  })
  return {
    scope: {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      mutate: async () => {},
      set,
      unset: async () => {},
    },
    set,
  }
}

function fakeClientContext(scope: SettingsScope<JevSettings>, registered: RegisteredCard[]) {
  return {
    settingsScope: { bind: () => scope },
    locale: { register: () => () => {} },
    slots: {
      inject: (_key: string, register: () => unknown) => register(),
      register: (options: RegisteredCard['options'], component: unknown) => {
        registered.push({ options, component })
        return () => {}
      },
    },
    effect: (callback: () => unknown) => callback(),
  }
}

let view: ReturnType<typeof render> | undefined
afterEach(() => {
  view?.unmount()
  view = undefined
})

describe('jev client card', () => {
  it('registers the bundle page under the package name with locale and inject face', () => {
    const { scope } = fakeScope({ provider: 'mock', mode: 'shadow' })
    const registered: RegisteredCard[] = []
    client.apply(fakeClientContext(scope, registered) as never)

    expect(registered).toHaveLength(1)
    expect(registered[0]?.options.name).toBe('plugins.bundle.config')
    expect(registered[0]?.options.key).toBe('@buberlo/dsh-jev')
    expect(registered[0]?.options.locale).toBe('settings.jev')
    expect(typeof registered[0]?.component).toBe('function')
  })

  it('renders the page and writes a mode change through the controller', async () => {
    const { scope, set } = fakeScope({ provider: 'mock', mode: 'shadow' })
    const face = new JevCardController(scope).inject()
    view = render(createElement(JevCard, {
      view: 'page',
      t: (key: keyof typeof en) => en[key],
      ...face,
    } as never))

    expect(view.container.textContent).toContain('DeepSeek Harness plans, calls tools, and runs them.')
    expect(view.container.textContent).toContain('mock')
    const enforce = view.getByRole('button', { name: 'Enforce' })
    await act(async () => { enforce.click() })
    expect(set).toHaveBeenCalledWith('mode', 'enforce')
  })

  it('renders feature state and writes a toggle', async () => {
    const { scope, set } = fakeScope({
      provider: 'mock',
      mode: 'shadow',
      skills: { enabled: false },
    })
    const face = new JevCardController(scope).inject()
    view = render(createElement(JevCard, {
      view: 'page',
      t: (key: keyof typeof en) => en[key],
      ...face,
    } as never))

    const skills = view.getByRole('checkbox', { name: /Skill routing/ })
    expect((skills as HTMLInputElement).checked).toBe(false)
    await act(async () => { skills.click() })
    expect(set).toHaveBeenCalledWith('skills.enabled', true)
  })

  it('switches the provider and writes a write-only API key', async () => {
    const { scope, set } = fakeScope({ provider: 'mock', mode: 'shadow' })
    const face = new JevCardController(scope).inject()
    view = render(createElement(JevCard, {
      view: 'page',
      t: (key: keyof typeof en) => en[key],
      ...face,
    } as never))

    const live = view.getByRole('button', { name: 'live' })
    await act(async () => { live.click() })
    expect(set).toHaveBeenCalledWith('provider', 'live')

    const key = view.getByPlaceholderText('Paste a TypeSafe API key')
    await act(async () => {
      key.setAttribute('value', 'ts-test-key')
      key.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const save = view.getByRole('button', { name: 'Save key' })
    await act(async () => { save.click() })
    expect(set).toHaveBeenCalledWith('apiKey', 'ts-test-key')
    // The value never stays in the DOM after saving.
    expect((view.getByPlaceholderText('Paste a TypeSafe API key') as HTMLInputElement).value).toBe('')
  })

  it('renders the one-line summary for the bundle page', () => {
    const { scope } = fakeScope({ provider: 'mock', mode: 'shadow' })
    const face = new JevCardController(scope).inject()
    view = render(createElement(JevCard, {
      view: 'summary',
      t: (key: keyof typeof en) => en[key],
      ...face,
    } as never))
    expect(view.container.textContent).toContain('Fast structured decisions along the DSH agent loop.')
  })

  it('shows the unavailable state without controls', () => {
    const unavailable: SettingsScope<JevSettings> = {
      getSnapshot: () => ({
        status: 'unavailable',
        value: undefined,
        base: undefined,
        user: undefined,
        revision: undefined,
        writable: false,
        mode: 'host',
      }),
      subscribe: () => () => {},
      mutate: async () => {},
      set: async () => {},
      unset: async () => {},
    }
    const face = new JevCardController(unavailable).inject()
    view = render(createElement(JevCard, {
      view: 'page',
      t: (key: keyof typeof en) => en[key],
      ...face,
    } as never))
    expect(view.container.textContent).toContain('Settings are not available in this deployment')
    expect(view.container.querySelector('button[type="button"]')).toBeNull()
  })
})
