/** @type {import('ts-jest').JestConfigWithTsJest} */
import type { JestConfigWithTsJest } from 'ts-jest'

const config: JestConfigWithTsJest = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  testPathIgnorePatterns: ['dist/'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  transform: {
    '^.+\\.ts?$': ['ts-jest', {
      useESM: true,
      tsconfig: {
        module: 'ESNext',
        moduleResolution: 'bundler',
        isolatedModules: true
      }
    }]
  },
  testMatch: ['**/test/integration/**/*.test.ts'], // Only run integration tests
  verbose: true,
  setupFilesAfterEnv: ['./jest.setup.ts'], // Ensures the test server/db start correctly
  testTimeout: 30000 // Longer timeout for integration tests
}

export default config
