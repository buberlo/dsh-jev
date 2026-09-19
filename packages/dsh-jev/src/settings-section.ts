/**
 * Host half of the plugin's settings surface.
 *
 * Registers the `jev` settings namespace so the web client can read and edit
 * the plugin configuration, and rebuilds the runtime on every committed
 * change. The namespace is registered only when a settings provider is
 * mounted; without one the plugin keeps running from its `cordis.yml` entry.
 *
 * `apiKey` carries `role('secret')` in the schema, so settings responses never
 * contain it even though the card cannot edit it.
 *
 * @module dsh-jev/settings-section
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { Config as ConfigSchema, type Config } from './config.js'
import type { JevRuntime } from './service.js'

/** Settings namespace owned by this plugin; the web card keys on it. */
export const JEV_SETTINGS_NS = 'jev'

/**
 * Install the settings section when a provider is present.
 * @param ctx - plugin context.
 * @param runtime - the service to reconfigure.
 * @param entry - the composed `cordis.yml` configuration (the composition layer).
 */
export function installSettingsSection(ctx: Context, runtime: JevRuntime, entry: Config): void {
  ctx.inject(['settings'], (settingsCtx) => {
    let source: () => Config = () => entry
    settingsCtx.settings.installSection(ctx, JEV_SETTINGS_NS, ConfigSchema, entry, {
      setSource: (current) => {
        source = current
      },
      onChange: () => {
        runtime.reconfigure(source())
      },
    })
  })
}
