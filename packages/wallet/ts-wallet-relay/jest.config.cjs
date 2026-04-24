/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    // Strip .js extensions so ts-jest can resolve TypeScript source files
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  testMatch: ['**/tests/**/*.test.ts', '**/tests/**/*.test.tsx'],
  projects: [
    {
      displayName: 'node',
      preset: 'ts-jest',
      testEnvironment: 'node',
      moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
      testMatch: ['**/tests/**/*.test.ts'],
    },
    {
      displayName: 'jsdom',
      preset: 'ts-jest',
      testEnvironment: 'jsdom',
      moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
      testMatch: ['**/tests/**/*.test.tsx'],
      setupFilesAfterEnv: ['@testing-library/jest-dom'],
    },
  ],
}
