import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Keep test timing results from rewriting the frozen installed runtime.
    cache: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      reporter: ['text', 'lcov']
    }
  }
})
