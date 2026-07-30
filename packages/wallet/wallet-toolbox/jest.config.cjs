//import { defaults } from 'jest-config'

/** @returns {Promise<import('jest').Config>} */
const getJestConfig = async () => {
  //console.log(defaults)
  return {
    bail: 0,
    verbose: true,
    // default is '.'
    rootDir: '.',
    // Must include source and test folders: default is ['<rootDir>']
    roots: ['<rootDir>'],
    // Speed up by restricting to module (source files) extensions used.
    moduleFileExtensions: ['ts', 'js'],
    // excluded source files...
    modulePathIgnorePatterns: ['out/src', 'out/test', '/dist/cjs/'],
    // Default is 'node'
    testEnvironment: 'node',
    // default [ '**/__tests__/**/*.[jt]s?(x)', '**/?(*.)+(spec|test).[tj]s?(x)' ]
    testMatch: ['**/?(*.)+(test).[tj]s', '**/__test/**/*.test.ts'],
    // default []
    testRegex: [],
    transform: {
      '^.+\\.ts$': [
        'ts-jest',
        {
          rootDir: '.',
          tsconfig: {
            module: 'commonjs',
            moduleResolution: 'bundler'
          }
        }
      ]
    },
    moduleNameMapper: {
      '^@bsv/sdk$': '<rootDir>/../../sdk/mod.ts',
      '^(\\.{1,2}/.*)\\.js$': '$1'
    },
    // SQLite-backed tests create multi-gigabyte fixture sets. Purge stale
    // artifacts before a run and remove the completed run's artifacts after
    // every Jest invocation so local worktrees cannot accumulate them.
    globalSetup: '<rootDir>/test/utils/cleanupTestDatabases.js',
    globalTeardown: '<rootDir>/test/utils/cleanupTestDatabases.js',
    testTimeout: 30000
  }
}

module.exports = getJestConfig
