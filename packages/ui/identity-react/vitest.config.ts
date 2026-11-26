import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    maxWorkers: 1,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: [
        'src/hooks/useIdentitySearch.ts',
        'src/utils/identityUtils.ts',
        'src/components/IdentitySearchField.tsx'
      ]
    }
  }
})
