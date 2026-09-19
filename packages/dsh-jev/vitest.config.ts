import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@buberlo/jev-core': fileURLToPath(new URL('../jev-core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: 'dsh-jev',
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    testTimeout: 20000,
  },
})
