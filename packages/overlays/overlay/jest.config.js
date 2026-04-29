/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testPathIgnorePatterns: ['dist/'],
  globals: {
    'ts-jest': {
      tsconfig: 'tsconfig.cjs.json',
    },
  },
}
