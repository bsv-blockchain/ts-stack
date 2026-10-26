const nobleTransform = ['babel-jest', { plugins: ['@babel/plugin-transform-modules-commonjs'] }]
const nobleTransformIgnore = ['node_modules/.pnpm/(?!(?:@noble\\+curves|@noble\\+hashes)@)']

/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  rootDir: '.',
  testEnvironment: 'node',
  testTimeout: 30000,
  transform: {
    '^.+\\.js$': nobleTransform,
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'commonjs',
          moduleResolution: 'bundler'
        }
      }
    ]
  },
  transformIgnorePatterns: nobleTransformIgnore,
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  testMatch: ['<rootDir>/tests/pairingUri*.test.ts']
}
