/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      useESM: true,
      tsconfig: {
        target: 'ES2020',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        esModuleInterop: true,
        resolveJsonModule: true,
        skipLibCheck: true,
        strict: false,
        allowImportingTsExtensions: false
      }
    }]
  },
  transformIgnorePatterns: [
    '/node_modules/(?!(@bsv/wallet-toolbox)/)'
  ],
  moduleNameMapper: {
    '^@bsv/sdk$': '<rootDir>/../../../packages/sdk/mod.ts',
    '^@bsv/sdk/storage$': '<rootDir>/../../../packages/sdk/src/storage/index.ts',
    '^@bsv/sdk/compat/(.*)$': '<rootDir>/../../../packages/sdk/src/compat/$1.ts',
    '^@bsv/sdk/primitives/(.*)$': '<rootDir>/../../../packages/sdk/src/primitives/$1.ts',
    // @wallet-toolbox/* → TS source (avoids barrel/knex, bypasses ESM/CJS interop issues)
    '^@wallet-toolbox/(.*)$': '<rootDir>/../../../packages/wallet/wallet-toolbox/src/$1.ts',
    // Map @bsv/wallet-toolbox subpath imports to wallet-toolbox source (avoids barrel/knex)
    '^@bsv/wallet-toolbox/(.*)\\.js$': '<rootDir>/../../../packages/wallet/wallet-toolbox/src/$1.ts',
    '^@bsv/wallet-toolbox/(.*)$': '<rootDir>/../../../packages/wallet/wallet-toolbox/src/$1.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  testMatch: ['**/*.test.ts'],
  testTimeout: 30000
}
