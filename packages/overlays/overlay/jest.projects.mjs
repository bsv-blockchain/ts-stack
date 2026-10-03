const nativeTests = String.raw`(?:[/\\]src[/\\]__tests[/\\]mongo[/\\][^/\\]*\.test\.ts$|[/\\]src[/\\]__tests__[/\\]PrivateOverlayHostRootServing\.integration\.test\.ts$)`
export const coreOverlayTestIgnorePatterns = [
  '/node_modules/',
  '<rootDir>/dist/',
  String.raw`<rootDir>/\.stryker-tmp/`
]
const shared = {
  testEnvironment: 'node',
  modulePathIgnorePatterns: ['<rootDir>/dist/', String.raw`<rootDir>/\.stryker-tmp/`],
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' }
}
/** Preserve legacy semantics and run the complete native selection with its real ESM driver. */
export function createCoreOverlayTestProjects(
  testMatch = ['**/__tests/**/*.test.ts'],
  options = {}
) {
  return [
    {
      ...shared,
      ...options,
      displayName: 'legacy-commonjs',
      testMatch,
      testPathIgnorePatterns: [...coreOverlayTestIgnorePatterns, nativeTests],
      extensionsToTreatAsEsm: [],
      transform: { '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.cjs.json' }] }
    },
    {
      ...shared,
      ...options,
      displayName: 'native-mongo-esm',
      testMatch,
      testPathIgnorePatterns: [...coreOverlayTestIgnorePatterns, `^(?!.*${nativeTests}).*$`],
      extensionsToTreatAsEsm: ['.ts'],
      moduleNameMapper: {
        ...shared.moduleNameMapper,
        '^@bsv/overlay$': '<rootDir>/mod.ts',
        '^@bsv/overlay/(.*)\\.ts$': '<rootDir>/src/$1.ts',
        '^@bsv/overlay/storage/mongo/(.*)$': '<rootDir>/src/storage/mongo/$1.ts',
        ...options.moduleNameMapper
      },
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
