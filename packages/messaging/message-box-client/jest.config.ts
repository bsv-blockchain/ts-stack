// jest.config.ts
import type { JestConfigWithTsJest } from 'ts-jest'

const config: JestConfigWithTsJest = {
  // Use the preset specifically designed for ESM
  preset: 'ts-jest/presets/default-esm',

  // Use the Node environment for testing
  testEnvironment: 'node',

  // Ignore compiled output
  testPathIgnorePatterns: [
    'dist/',
    '/node_modules/',
    './src/__tests/integration/'
  ],

  // Keep ts-jest options in transform to avoid deprecated globals config
  transform: {
    '^.+\\.ts$': ['ts-jest', { useESM: true, isolatedModules: true }]
  },

  // Tell Jest that files ending in .ts should be treated as ESM modules
  extensionsToTreatAsEsm: ['.ts'],

  // Optionally, if you have imports with a .js extension in your source (or tests)
  // but your source files are actually TypeScript, this mapper will remove the extension.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  }
}

export default config
