const privateTests = String.raw`[/\\]src[/\\]__tests__[/\\]Private(?:Acquisition|Publication|OverlayHost|Buyer)[^/\\]*\.test\.ts$`
export const overlayTestIgnorePatterns = [
  '<rootDir>/dist/',
  '/node_modules/',
  String.raw`\.live\.test\.ts$`,
  String.raw`<rootDir>/\.stryker-tmp/`
]
const shared = {
  testEnvironment: 'node',
  modulePathIgnorePatterns: ['<rootDir>/dist/', String.raw`<rootDir>/\.stryker-tmp/`],
  setupFilesAfterEnv: ['<rootDir>/src/__tests__/setup.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^uuid$': '<rootDir>/node_modules/uuid/dist/index.js'
  },
  transformIgnorePatterns: ['node_modules/(?!(uuid)/)']
}
/** Both projects receive the complete selected union; their module partitions are disjoint. */
export function createOverlayTestProjects(
  testMatch = ['**/__tests__/**/*.test.ts', '**/?(*.)+(spec|test).ts']
) {
  return [
    {
      ...shared,
      displayName: 'legacy-commonjs',
      cacheDirectory: '<rootDir>/node_modules/.cache/jest-legacy-commonjs',
      testMatch,
      testPathIgnorePatterns: [...overlayTestIgnorePatterns, privateTests],
      extensionsToTreatAsEsm: [],
      transform: {
        '^.+\\.tsx?$': [
          'ts-jest',
          {
            useESM: true,
            tsconfig: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler' }
          }
        ]
      }
    },
    {
      ...shared,
      displayName: 'private-esm',
      cacheDirectory: '<rootDir>/node_modules/.cache/jest-private-esm',
      testMatch,
      testPathIgnorePatterns: [...overlayTestIgnorePatterns, `^(?!.*${privateTests}).*$`],
      extensionsToTreatAsEsm: ['.ts', '.tsx'],
      transform: {
        '^.+\\.tsx?$': [
          'ts-jest',
          {
            useESM: true,
            tsconfig: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler' }
          }
        ]
      }
    }
  ]
}
