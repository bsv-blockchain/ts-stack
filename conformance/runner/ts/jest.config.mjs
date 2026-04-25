/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      useESM: true,
      tsconfig: {
        target: 'ES2020',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        esModuleInterop: true,
        resolveJsonModule: true,
        skipLibCheck: true,
        strict: false
      }
    }]
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  testMatch: ['**/*.test.ts'],
  testTimeout: 30000
}
