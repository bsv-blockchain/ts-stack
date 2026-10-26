const nobleTransform = ['babel-jest', { plugins: ['@babel/plugin-transform-modules-commonjs'] }]
const nobleTransformIgnore = ['node_modules/.pnpm/(?!(?:@noble\\+curves|@noble\\+hashes)@)']

/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testTimeout: 30000,
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    // React's public barrel contains re-exports only; executable modules remain measured.
    '!src/react.tsx',
    'template/backend/server.ts',
    'template/nextjs/app/api/**/*.ts'
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
    '^.+\\.js$': nobleTransform,
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
  transformIgnorePatterns: nobleTransformIgnore,
  moduleNameMapper: {
    // Strip .js extensions so ts-jest can resolve TypeScript source files
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^next/server$': '<rootDir>/tests/fixtures/next-server.ts',
    '^(?:\\.\\./){3,4}lib/relay$': '<rootDir>/tests/fixtures/template-relay.ts'
  },
  testMatch: ['**/tests/**/*.test.ts', '**/tests/**/*.test.tsx'],
  projects: [
    {
      displayName: 'node',
      preset: 'ts-jest',
      testEnvironment: 'node',
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
        '^(\\.{1,2}/.*)\\.js$': '$1',
        '^next/server$': '<rootDir>/tests/fixtures/next-server.ts',
        '^(?:\\.\\./){3,4}lib/relay$': '<rootDir>/tests/fixtures/template-relay.ts'
      },
      testMatch: ['**/tests/**/*.test.ts']
    },
    {
      displayName: 'jsdom',
      preset: 'ts-jest',
      testEnvironment: 'jsdom',
      transform: {
        '^.+\\.js$': nobleTransform,
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
      transformIgnorePatterns: nobleTransformIgnore,
      moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
      testMatch: ['**/tests/**/*.test.tsx'],
      setupFilesAfterEnv: ['@testing-library/jest-dom']
    }
  ]
}
