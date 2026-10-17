/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testPathIgnorePatterns: [
    '<rootDir>/dist/',
    '<rootDir>/node_modules/',
    String.raw`<rootDir>/\.stryker-tmp/`
  ],
  // Ignore generated children, including interrupted mutation runs. The active
  // Stryker sandbox is itself a root and must still discover all authored tests.
  modulePathIgnorePatterns: ['<rootDir>/dist/', String.raw`<rootDir>/\.stryker-tmp/`],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'commonjs',
          moduleResolution: 'bundler',
          strict: false,
          strictNullChecks: false,
          noImplicitAny: false,
          useDefineForClassFields: false
        }
      }
    ]
  },
  // Integration tests use fixed ports and multi-round-trip auth protocol
  // exchanges that require sequential execution to avoid worker event-loop
  // scheduling issues and port conflicts.
  maxWorkers: 1,
  collectCoverageFrom: ['mod.ts', 'src/**/*.ts', '!src/__tests/**'],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 85,
      lines: 85,
      statements: 85
    }
  }
}
