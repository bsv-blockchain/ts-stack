/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  roots: ['<rootDir>/src', '<rootDir>/bench'],
  moduleNameMapper: {
    // Dev-only: use LOCAL sdk source so the new Transaction.verify(verifier)
    // signature is visible despite the repo-wide @bsv/sdk:2.1.3 override.
    '^@bsv/sdk$': '<rootDir>/../sdk/mod.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { useESM: true, tsconfig: { allowJs: true } }]
  }
}
