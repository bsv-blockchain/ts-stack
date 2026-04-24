/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
    preset: 'ts-jest/presets/default-esm',
    testEnvironment: 'node',
    testPathIgnorePatterns: ['dist/'],
    testTimeout: 30000,
    setupFilesAfterEnv: ['<rootDir>/jest.setup.cjs'],
    extensionsToTreatAsEsm: ['.ts'],
    transform: {
        '^.+\\.ts$': ['ts-jest', { useESM: true }]
    },
    moduleNameMapper: {
        '^(\\.{1,2}/.*)\\.js$': '$1'
    },
    transformIgnorePatterns: [
        'node_modules/(?!(node-fetch|cross-fetch)/)'
    ]
}
  