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
    moduleFileExtensions: ['ts', 'js', 'cjs'],
    // excluded source files...
    modulePathIgnorePatterns: ['out/src', 'out/test', '/dist/cjs/', String.raw`<rootDir>/\.stryker-tmp/`],
    // Ignore generated children of this test root. Stryker runs with a sandbox
    // as its root, so an unanchored sandbox pattern would hide its own tests.
    // Module discovery retains the same boundary when package commands replace
    // testPathIgnorePatterns with their governed manual/live test policy.
    testPathIgnorePatterns: ['/node_modules/', String.raw`<rootDir>/\.stryker-tmp/`],
    // Default is 'node'
    testEnvironment: 'node',
    // Bind these stable intrinsics to the same objects already in this Jest
    // realm, avoiding repeated VM global lookup overhead.
    // Keep replaceable clocks, fetch, WebAssembly and typed-array globals dynamic.
    // Buffer remains a global lookup so CommonJS modules can declare its import.
    sandboxInjectedGlobals: ['Math', 'String', 'Number', 'Object', 'Array', 'Reflect'],
    // default [ '**/__tests__/**/*.[jt]s?(x)', '**/?(*.)+(spec|test).[tj]s?(x)' ]
    testMatch: ['**/?(*.)+(test).[tj]s', '**/__test/**/*.test.ts', '**/*.test.cjs'],
    // default []
    testRegex: [],
    transform: {
      '^.+\\.ts$': [
        'ts-jest',
        {
          rootDir: '.',
          // Stryker relocates the test root. Resolve the source-owned compiler
          // config here so its inherited settings retain their original base.
          tsconfig: require.resolve('./tsconfig.jest.json')
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
    globalSetup: '<rootDir>/test/utils/setupOwnedTestRuntime.cjs',
    globalTeardown: '<rootDir>/test/utils/teardownOwnedTestRuntime.cjs',
    testTimeout: 30000
  }
}

module.exports = getJestConfig
