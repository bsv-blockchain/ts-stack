/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  // Use the preset specifically designed for ESM
  preset: 'ts-jest/presets/default-esm',

  // Use the Node environment for testing
  testEnvironment: 'node',

  // Ignore compiled output
  testPathIgnorePatterns: ['dist/', 'node_modules/'],

  // Configure transform for ESM
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      useESM: true,
      tsconfig: 'tsconfig.jest.json'
    }]
  },

  // Tell Jest that files ending in .ts should be treated as ESM modules
  extensionsToTreatAsEsm: ['.ts'],

  // Map .js imports to .ts files for ESM compatibility  
  moduleNameMapper: {
    './docs/KVStoreLookupDocs.md.js': '<rootDir>/src/__tests/__mocks__/lookupDocsMock.js',
    './docs/KVStoreTopicManagerDocs.md.js': '<rootDir>/src/__tests/__mocks__/topicDocsMock.js',
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },

  // Resolve modules properly
  moduleFileExtensions: ['ts', 'js', 'json'],
  
  // Transform ignore patterns for node_modules
  transformIgnorePatterns: [
    'node_modules/(?!(@bsv/.*)/)'
  ]
}
