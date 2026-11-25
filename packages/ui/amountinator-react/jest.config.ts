import type { Config } from 'jest'

const config: Config = {
  bail: 1,
  verbose: true,
  rootDir: '.',
  roots: ['<rootDir>'],
  moduleFileExtensions: ['ts', 'js'],
  modulePathIgnorePatterns: ['out/src', 'out/test'],
  testEnvironment: 'node',
  testMatch: ['**/?(*.)+(test).[tj]s'],
  testRegex: [],
  transform: { '^.+\\.ts$': ['ts-jest', { rootDir: '.' }] }
}

export default config
