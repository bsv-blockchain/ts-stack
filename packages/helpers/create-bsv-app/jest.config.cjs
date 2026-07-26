module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'commonjs',
          moduleResolution: 'bundler',
          esModuleInterop: true,
          types: ['node', 'jest']
        }
      }
    ]
  }
}
