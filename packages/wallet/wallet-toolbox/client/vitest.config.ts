import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: '..',
  test: {
    environment: 'node',
    include: ['client/test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/index.client.ts', 'src/services/chaintracker/chaintracks/Api/BlockHeaderApi.ts'],
      reportsDirectory: 'client/coverage',
      reporter: ['text', 'lcov'],
      thresholds: {
        lines: 100,
        branches: 100,
        functions: 100,
        statements: 100
      }
    }
  }
})
