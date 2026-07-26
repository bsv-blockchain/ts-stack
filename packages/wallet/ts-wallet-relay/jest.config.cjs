/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testTimeout: 30000,
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    // Public entrypoints contain re-exports only; executable modules remain measured.
    '!src/client.ts',
    '!src/index.ts',
    '!src/react.tsx'
  ],
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 75,
      lines: 80,
      statements: 80
    }
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'commonjs',
          moduleResolution: 'bundler',
          jsx: 'react-jsx'
        }
      }
    ]
  },
  moduleNameMapper: {
    // Strip .js extensions so ts-jest can resolve TypeScript source files
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  testMatch: ['**/tests/**/*.test.ts', '**/tests/**/*.test.tsx'],
  projects: [
    {
      displayName: 'node',
      preset: 'ts-jest',
      testEnvironment: 'node',
      transform: {
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
      moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
      testMatch: ['**/tests/**/*.test.ts']
    },
    {
      displayName: 'jsdom',
      preset: 'ts-jest',
      testEnvironment: 'jsdom',
      transform: {
        '^.+\\.tsx?$': [
          'ts-jest',
          {
            tsconfig: {
              module: 'commonjs',
              moduleResolution: 'bundler',
              jsx: 'react-jsx'
            }
          }
        ]
      },
      moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
      testMatch: ['**/tests/**/*.test.tsx'],
      setupFilesAfterEnv: ['@testing-library/jest-dom']
    }
  ]
}
