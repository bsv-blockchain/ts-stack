import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // The templates import the package by name, as a copied file would; in
    // here that name must reach the source, not a stale dist.
    alias: {
      '@bsv/group-messaging': fileURLToPath(new URL('./src/index.ts', import.meta.url))
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts', 'templates/**/__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // `templates/` ships as source, so patch coverage counts it as changed
      // production code and wants it in the LCOV like anything else.
      include: ['src/**/*.ts', 'templates/**/*.ts'],
      exclude: ['src/**/__tests__/**', 'templates/**/__tests__/**'],
      reporter: ['text', 'lcov']
    }
  }
})
