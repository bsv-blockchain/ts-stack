/** @type {import('jest').Config} */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { useESM: true, tsconfig: 'tsconfig.json' }]
  },
  testMatch: ['<rootDir>/test/**/*.test.ts'],
  collectCoverageFrom: ['src/**/*.ts', 'server/**/*.ts'],
  coverageThreshold: {
    global: { branches: 90, functions: 85, lines: 90, statements: 90 }
  },
  testTimeout: 60000
}
