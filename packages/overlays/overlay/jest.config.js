/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  testEnvironment: 'node',
  testPathIgnorePatterns: ['<rootDir>/dist/'],
  modulePathIgnorePatterns: ['<rootDir>/dist/'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: 'tsconfig.cjs.json'
      }
    ]
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.test.ts', '!src/**/__tests__/**']
}
