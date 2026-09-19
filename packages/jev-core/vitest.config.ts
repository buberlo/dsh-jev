import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'jev-core',
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
  },
})
