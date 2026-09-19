/**
 * Client bundle for the DSH web client.
 *
 * The DSH client module system serves the `./client` export as a closure
 * factory: the artifact calls `window.__ModuleLoader__.load({ id, factory })`
 * and resolves `react` through the injected require. The upstream build
 * preset is not published, so this config reproduces the artifact contract
 * directly (CJS, banner/intro/footer, module-table externals only).
 *
 * Cross-plugin value imports are forbidden; everything imported from another
 * client package here is type-only and erased.
 */

import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  target: 'es2022',
  dts: false,
  clean: false,
  sourcemap: true,
  deps: { neverBundle: ['react', 'react/jsx-runtime'] },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "@buberlo/dsh-jev", factory: (require) => {',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
})
