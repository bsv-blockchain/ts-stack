/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testPathIgnorePatterns: ['dist/'],
  modulePathIgnorePatterns: ['<rootDir>/dist/'], // Add this to ignore dist/ for module mapping
  // Integration tests use fixed ports and multi-round-trip auth protocol
  // exchanges that require sequential execution to avoid worker event-loop
  // scheduling issues and port conflicts.
  maxWorkers: 1
}
