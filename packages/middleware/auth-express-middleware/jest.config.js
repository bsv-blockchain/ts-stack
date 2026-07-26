/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testPathIgnorePatterns: ['dist/'],
  modulePathIgnorePatterns: ['<rootDir>/dist/'], // Add this to ignore dist/ for module mapping
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
  collectCoverageFrom: ['src/**/*.ts', '!src/__tests/**'],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 85,
      lines: 85,
      statements: 85
    }
  }
}
