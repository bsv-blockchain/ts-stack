/** @type {import('jest').Config} */
module.exports = {
  bail: 1,
  moduleFileExtensions: ['ts', 'js'],
  modulePathIgnorePatterns: ['out/src', 'out/test', 'dist'],
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/.stryker-tmp/'],
  rootDir: '.',
  roots: ['<rootDir>'],
  testEnvironment: 'node',
  testMatch: ['**/?(*.)+(test).[tj]s'],
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
  verbose: true
}
