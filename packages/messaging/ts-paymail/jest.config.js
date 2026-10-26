/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  testPathIgnorePatterns: ['dist/', 'dist-*/'],
  testTimeout: 30000,
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/__tests/**',
    'docs/examples/src/client/sendP2P.ts',
    'docs/examples/src/client/sendP2PBeef.ts',
    'docs/examples/src/mockUser.ts',
    'docs/examples/src/server/receiveBeefTransaction.ts',
    'docs/examples/src/server/receiveTransaction.ts',
    'docs/examples/src/wocClient.ts'
  ],
  coverageThreshold: {
    global: {
      branches: 85,
      functions: 95,
      lines: 95,
      statements: 95
    }
  },
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.ts$': [
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
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  transformIgnorePatterns: ['node_modules/(?!(node-fetch|cross-fetch)/)']
}
