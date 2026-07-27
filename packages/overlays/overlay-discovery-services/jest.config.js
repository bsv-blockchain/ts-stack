/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  testEnvironment: 'node',
  testPathIgnorePatterns: ['<rootDir>/dist/'],
  modulePathIgnorePatterns: ['<rootDir>/dist/'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: {
          module: 'ESNext',
          moduleResolution: 'bundler'
        }
      }
    ]
  },
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.test.ts', '!src/**/__tests__/**'],
  testTimeout: 30000
}
