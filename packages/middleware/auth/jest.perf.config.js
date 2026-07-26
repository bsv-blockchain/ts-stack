const base = require('./jest.config')

// Runs ONLY the perf benchmark (which the default `jest` run excludes).
module.exports = {
  ...base,
  testMatch: ['**/__tests__/**/*.perf.test.ts'],
  testPathIgnorePatterns: ['/node_modules/']
}
