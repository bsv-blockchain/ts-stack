/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/bench'],
  testPathIgnorePatterns: ['dist/'],
  modulePathIgnorePatterns: ['<rootDir>/dist'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/__tests/**',
    '!src/wasm/**',
    // These are process entrypoints exercised by real worker/consumer tests;
    // Jest cannot merge coverage emitted by their separate runtimes.
    '!src/workers/BdkVerifierBrowserWorker.ts',
    '!src/workers/BdkVerifierNodeWorker.ts'
  ],
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 72,
      lines: 75,
      statements: 72
    }
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        useESM: true,
        diagnostics: false,
        tsconfig: {
          target: 'ES2020',
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: false,
          strictNullChecks: false,
          noImplicitAny: false,
          strictPropertyInitialization: false,
          skipLibCheck: true,
          allowJs: true,
          types: ['node', 'jest']
        }
      }
    ]
  },
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    // Dev-only: test against the workspace SDK source used by the stack.
    '^@bsv/sdk$': '<rootDir>/../sdk/mod.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1'
  }
}
