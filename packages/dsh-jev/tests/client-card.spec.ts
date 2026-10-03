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

import { act, fireEvent } from '@testing-library/react'
import { render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import * as client from '../src/client/index.js'
import { JevCardController, type JevSettings, type JevCardFace } from '../src/client/jev-card-controller.js'
import { JevCard } from '../src/client/JevCard.js'
import { en } from '../src/client/locales.js'

interface RegisteredCard {
  readonly options: { name: string; key: string; locale?: string; inject?: () => JevCardFace }
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
    const next = structuredClone(snapshot.value ?? {})
    const segments = field.split('.')
    const leaf = segments.pop()!
    let target = next as Record<string, unknown>
    for (const segment of segments) {
      target[segment] ??= {}
      target = target[segment] as Record<string, unknown>
    }
    target[leaf] = value
    snapshot = { ...snapshot, value: next }
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

  it('loads route options from the global host catalog, preserving slash IDs and remote errors', async () => {
    const { scope } = fakeScope({})
    const registered: RegisteredCard[] = []
    const modelCatalog = vi.fn(async () => ({ ok: true, value: { groups: [{ id: 'gateway', name: 'Gateway', models: [{ id: 'vendor/pro', name: 'Pro' }] }] } }))
    const remote = { get session() {
      if (!client.inject.includes('remote.session')) throw new Error('cannot get property "remote.session" without inject')
      return { modelCatalog }
    } }
    client.apply({ ...fakeClientContext(scope, registered), remote } as never)
    const face = registered[0]!.options.inject!()
    expect(await face.loadModels!()).toEqual([{ provider: 'gateway', model: 'vendor/pro', name: 'Gateway / Pro' }])
    modelCatalog.mockResolvedValueOnce({ ok: false, error: { message: 'Catalog rejected' } } as never)
    await expect(face.loadModels!()).rejects.toThrow('Catalog rejected')
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

  it('shows routing off when no routing setting exists', () => {
    const { scope } = fakeScope({})
    view = render(createElement(JevCard, { view: 'page', t: (key: keyof typeof en) => en[key], ...new JevCardController(scope).inject() } as never))
    expect((view.getByRole('checkbox', { name: /Model routing/ }) as HTMLInputElement).checked).toBe(false)
  })

  it('selects catalog models and saves their provider/model pair', async () => {
    const { scope, set } = fakeScope({ modelRouting: { enabled: true, routes: { fast: { provider: 'gateway', model: 'flash' } } } } as JevSettings)
    const controller = new JevCardController(scope)
    const props = () => ({ view: 'page', t: (key: keyof typeof en) => en[key], ...controller.inject(), loadModels: async () => [{ provider: 'gateway', model: 'flash' }, { provider: 'gateway', model: 'pro' }, { provider: 'gateway', model: 'reasoner' }] } as never)
    view = render(createElement(JevCard, props()))
    await act(async () => {})
    const select = view.getByRole('combobox', { name: 'balanced Model' }) as HTMLSelectElement
    expect(view.queryByRole('textbox', { name: 'fast Provider' })).toBeNull()
    expect(view.getAllByText('Not configured')).toHaveLength(2)
    expect((view.getByRole('button', { name: 'Save balanced route' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(select, { target: { value: JSON.stringify(['gateway', 'pro']) } })
    await act(async () => { view!.getByRole('button', { name: 'Save balanced route' }).click() })
    expect(set).toHaveBeenCalledWith('modelRouting.routes.balanced', { provider: 'gateway', model: 'pro' })
    view.unmount()
    view = render(createElement(JevCard, props()))
    await act(async () => {})
    expect((view.getByRole('combobox', { name: 'balanced Model' }) as HTMLSelectElement).value).toBe(JSON.stringify(['gateway', 'pro']))
    expect((view.getByRole('combobox', { name: 'fast Model' }) as HTMLSelectElement).value).toBe(JSON.stringify(['gateway', 'flash']))
  })

  it('shows route save failures without claiming the draft is configured', async () => {
    const { scope } = fakeScope({})
    const face = new JevCardController(scope).inject()
    view = render(createElement(JevCard, { view: 'page', t: (key: keyof typeof en) => en[key], ...face, loadModels: async () => [{ provider: 'gateway', model: 'flash' }], setField: async () => { throw new Error('Write rejected') } } as never))
    await act(async () => {})
    fireEvent.change(view.getByRole('combobox', { name: 'fast Model' }), { target: { value: JSON.stringify(['gateway', 'flash']) } })
    await act(async () => { view!.getByRole('button', { name: 'Save fast route' }).click() })
    expect(view.container.textContent).toContain('Write rejected')
    expect(view.getAllByText('Not configured')).toHaveLength(3)
  })

  it('refreshes routing values when the host snapshot changes', async () => {
    const { scope, set } = fakeScope({})
    const controller = new JevCardController(scope)
    const props = () => ({ view: 'page', t: (key: keyof typeof en) => en[key], ...controller.inject(), loadModels: async () => [{ provider: 'gateway', model: 'flash' }, { provider: 'gateway', model: 'pro' }, { provider: 'gateway', model: 'reasoner' }] } as never)
    view = render(createElement(JevCard, props()))
    await set('modelRouting.enabled', true)
    await set('modelRouting.routes.reasoning', { provider: 'gateway', model: 'reasoner' })
    view.rerender(createElement(JevCard, props()))
    expect((view.getByRole('checkbox', { name: /Model routing/ }) as HTMLInputElement).checked).toBe(true)
    await act(async () => {})
    expect((view.getByRole('combobox', { name: 'reasoning Model' }) as HTMLSelectElement).value).toBe(JSON.stringify(['gateway', 'reasoner']))
  })

  it('rolls back a rejected routing toggle and reports the write failure', async () => {
    const { scope } = fakeScope({})
    view = render(createElement(JevCard, { view: 'page', t: (key: keyof typeof en) => en[key], ...new JevCardController(scope).inject(), setField: async () => { throw new Error('Write rejected') } } as never))
    const toggle = view.getByRole('checkbox', { name: /Model routing/ }) as HTMLInputElement
    await act(async () => { toggle.click() })
    expect(toggle.checked).toBe(false)
    expect(view.container.textContent).toContain('Write rejected')
  })

  it('keeps route fields visible but disabled for read-only settings', () => {
    const { scope } = fakeScope({ modelRouting: { routes: { fast: { provider: 'gateway', model: 'flash' } } } })
    const face = new JevCardController(scope).inject()
    view = render(createElement(JevCard, { view: 'page', t: (key: keyof typeof en) => en[key], ...face, snapshot: { ...face.snapshot, writable: false } } as never))
    const input = view.getByRole('combobox', { name: 'fast Model' }) as HTMLSelectElement
    expect(view.container.textContent).toContain('gateway / flash')
    expect(input.matches(':disabled')).toBe(true)
    expect(view.container.textContent).toContain('This client cannot write settings here.')
  })

  it('preserves unlisted configured routes but prevents saving them', async () => {
    const { scope } = fakeScope({ modelRouting: { routes: { fast: { provider: 'removed', model: 'old' } } } })
    view = render(createElement(JevCard, { view: 'page', t: (key: keyof typeof en) => en[key], ...new JevCardController(scope).inject(), loadModels: async () => [{ provider: 'gateway', model: 'flash' }] } as never))
    await act(async () => {})
    expect(view.container.textContent).toContain('removed / old')
    expect((view.getByRole('button', { name: 'Save fast route' }) as HTMLButtonElement).disabled).toBe(true)
    expect(view.container.textContent).toContain('Not available')
  })

  it('reports catalog errors without inventing available models', async () => {
    const { scope } = fakeScope({})
    view = render(createElement(JevCard, { view: 'page', t: (key: keyof typeof en) => en[key], ...new JevCardController(scope).inject(), loadModels: async () => { throw new Error('Catalog offline') } } as never))
    await act(async () => {})
    expect(view.container.textContent).toContain('Catalog offline')
    expect((view.getByRole('combobox', { name: 'fast Model' }) as HTMLSelectElement).matches(':disabled')).toBe(true)
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
