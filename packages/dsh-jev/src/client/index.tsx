/**
 * Browser half of `@buberlo/dsh-jev`: the Jev configuration page in the DSH
 * web client's Plugins page.
 *
 * The page is keyed by the bundle package name, so it appears on this
 * bundle's own page. All data arrives through the injected Cordis services
 * (`slots`, `locale`, `configForms`); no cross-plugin value import exists.
 *
 * @module dsh-jev/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the Plugins page's SlotMap merge (`plugins.bundle.config`).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
// Type-only: the config-forms service and the settings shell's declarations.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots) and the renderer.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { JevCardController, type JevSettings } from './jev-card-controller.js'
import { JevCard } from './JevCard.js'
import { de, en, type JevKey } from './locales.js'

export type { JevCardFace, JevFeatureState, JevSettings } from './jev-card-controller.js'
export type { JevCardProps } from './JevCard.js'
export type { JevKey } from './locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Jev configuration page copy. */
    'settings.jev': JevKey
  }
}

/** Client services this plugin requires. */
export const inject = ['slots', 'locale', 'remote', 'configForms']

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.jev'

/** Settings namespace owned by this plugin: the Host profile entry id. */
const SETTINGS_NS = 'jev'

/** Keyed slot identity: the bundle's own package name. */
const BUNDLE_KEY = '@buberlo/dsh-jev'

/**
 * Register the bundle's configuration page.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const controller = new JevCardController(ctx.configForms.get<JevSettings>(SETTINGS_NS))
  ctx.effect(() => ctx.locale.register(NS, 'en', en), 'dsh-jev: en dictionary')
  ctx.effect(() => ctx.locale.register(NS, 'de', de), 'dsh-jev: de dictionary')
  // The bundle's configuration page exists only while the Host serves this
  // plugin's profile entry, so an unmounted plugin leaves no trace on the page.
  ctx.effect(() => ctx.configForms.whileServed([SETTINGS_NS], () => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: BUNDLE_KEY,
    locale: NS,
    inject: () => controller.inject(),
  }, JevCard))), 'dsh-jev: bundle configuration page')
}
