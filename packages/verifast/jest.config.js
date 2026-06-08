/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/bench'],
  testPathIgnorePatterns: ['dist/'],
  modulePathIgnorePatterns: ['<rootDir>/dist'],
  transform: {
    '^.+\\.ts$': ['ts-jest', {
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
    }]
  },
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    // Dev-only: use LOCAL sdk source so the new Transaction.verify(verifier)
    // signature is visible despite the repo-wide @bsv/sdk:2.1.3 override.
    '^@bsv/sdk$': '<rootDir>/../sdk/mod.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1'
  }
}
