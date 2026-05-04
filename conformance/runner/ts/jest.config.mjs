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
    '^@bsv/sdk$': '<rootDir>/../../../packages/sdk/mod.ts',
    '^@bsv/sdk/storage$': '<rootDir>/../../../packages/sdk/src/storage/index.ts',
    '^@bsv/sdk/compat/(.*)$': '<rootDir>/../../../packages/sdk/src/compat/$1.ts',
    '^@bsv/sdk/primitives/(.*)$': '<rootDir>/../../../packages/sdk/src/primitives/$1.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  testMatch: ['**/*.test.ts'],
  testTimeout: 30000
}
