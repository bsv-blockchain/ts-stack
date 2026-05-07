import type { Config } from 'jest'
//import { defaults } from 'jest-config'

const getJestConfig = async (): Promise<Config> => {
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
    testMatch: ['**/?(*.)+(test).[tj]s',"**/__test/**/*.test.ts"],
    // default []
    testRegex: [],
    transform: { '^.+\\.ts$': ['ts-jest', { rootDir: '.' }] },
    testTimeout: 30000,
  }
}

export default getJestConfig
