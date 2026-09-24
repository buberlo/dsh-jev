// @vitest-environment jsdom
/**
 * Browser-half coverage for the Jev configuration card.
 *
 * The published `@deepseek-ai/dsh-client-test-runtime` slot bench cannot be
 * loaded from npm at the versions this repository verifies (recorded in
 * docs/upstream-compatibility.md), so the test exercises the same layers
 * directly: `apply()` against a recording fake context for the registration
 * wiring, and the real component with the real controller for the
 * interactions. The fake `configForms` form mirrors the rc.1 `ConfigForm`
 * contract, where a field write is an ordered path operation.
 */

import { act } from '@testing-library/react'
import { render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import * as client from '../src/client/index.js'
import { JevCardController, type JevSettings } from '../src/client/jev-card-controller.js'
import { JevCard } from '../src/client/JevCard.js'
import { en } from '../src/client/locales.js'

interface RegisteredCard {
  readonly options: { name: string; key: string; locale?: string }
  readonly component: unknown
}

function fakeForm(initial: JevSettings): {
  form: ConfigForm<JevSettings>
  mutate: ReturnType<typeof vi.fn>
} {
  const snapshot: ConfigFormSnapshot<JevSettings> = {
    status: 'ready',
    value: initial,
    base: initial,
    user: {},
    revision: 1,
    writable: true,
    mode: 'host',
  }
  const mutate = vi.fn(async () => true)
  return {
    form: {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      mutate,
      set: async () => true,
      unset: async () => true,
    },
    mutate,
  }
}

function fakeClientContext(form: ConfigForm<JevSettings>, registered: RegisteredCard[]) {
  return {
    configForms: {
      get: () => form,
      whileServed: (_namespaces: readonly string[], register: () => () => void) => register(),
    },
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
    const { form } = fakeForm({ provider: 'mock', mode: 'shadow' })
    const registered: RegisteredCard[] = []
    client.apply(fakeClientContext(form, registered) as never)

    expect(registered).toHaveLength(1)
    expect(registered[0]?.options.name).toBe('plugins.bundle.config')
    expect(registered[0]?.options.key).toBe('@buberlo/dsh-jev')
    expect(registered[0]?.options.locale).toBe('settings.jev')
    expect(typeof registered[0]?.component).toBe('function')
  })

  it('renders the page and writes a mode change through the controller', async () => {
    const { form, mutate } = fakeForm({ provider: 'mock', mode: 'shadow' })
    const face = new JevCardController(form).inject()
    view = render(createElement(JevCard, {
      view: 'page',
      t: (key: keyof typeof en) => en[key],
      ...face,
    } as never))

    expect(view.container.textContent).toContain('DeepSeek Harness plans, calls tools, and runs them.')
    expect(view.container.textContent).toContain('mock')
    const enforce = view.getByRole('button', { name: 'Enforce' })
    await act(async () => { enforce.click() })
    expect(mutate).toHaveBeenCalledWith([{ op: 'set', path: ['mode'], value: 'enforce' }])
  })

  it('renders feature state and writes a nested toggle', async () => {
    const { form, mutate } = fakeForm({
      provider: 'mock',
      mode: 'shadow',
      skills: { enabled: false },
    })
    const face = new JevCardController(form).inject()
    view = render(createElement(JevCard, {
      view: 'page',
      t: (key: keyof typeof en) => en[key],
      ...face,
    } as never))

    const skills = view.getByRole('checkbox', { name: /Skill routing/ })
    expect((skills as HTMLInputElement).checked).toBe(false)
    await act(async () => { skills.click() })
    expect(mutate).toHaveBeenCalledWith([{ op: 'set', path: ['skills', 'enabled'], value: true }])
  })

  it('switches the provider and writes a write-only API key', async () => {
    const { form, mutate } = fakeForm({ provider: 'mock', mode: 'shadow' })
    const face = new JevCardController(form).inject()
    view = render(createElement(JevCard, {
      view: 'page',
      t: (key: keyof typeof en) => en[key],
      ...face,
    } as never))

    const live = view.getByRole('button', { name: 'live' })
    await act(async () => { live.click() })
    expect(mutate).toHaveBeenCalledWith([{ op: 'set', path: ['provider'], value: 'live' }])

    const key = view.getByPlaceholderText('Paste a TypeSafe API key')
    await act(async () => {
      key.setAttribute('value', 'ts-test-key')
      key.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const save = view.getByRole('button', { name: 'Save key' })
    await act(async () => { save.click() })
    expect(mutate).toHaveBeenCalledWith([{ op: 'set', path: ['apiKey'], value: 'ts-test-key' }])
    // The value never stays in the DOM after saving.
    expect((view.getByPlaceholderText('Paste a TypeSafe API key') as HTMLInputElement).value).toBe('')
  })

  it('renders the one-line summary for the bundle page', () => {
    const { form } = fakeForm({ provider: 'mock', mode: 'shadow' })
    const face = new JevCardController(form).inject()
    view = render(createElement(JevCard, {
      view: 'summary',
      t: (key: keyof typeof en) => en[key],
      ...face,
    } as never))
    expect(view.container.textContent).toContain('Fast structured decisions along the DSH agent loop.')
  })

  it('shows the unavailable state without controls', () => {
    const unavailable: ConfigForm<JevSettings> = {
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
      mutate: async () => true,
      set: async () => true,
      unset: async () => true,
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
