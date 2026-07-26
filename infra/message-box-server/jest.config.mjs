// jest.config.mjs - ES Module version of Jest config
export default {
  roots: ['./src'],
  // Setup file to provide globals and env vars
  setupFilesAfterEnv: ['./jest.setup.mjs'],
  // Use Node environment
  testEnvironment: 'node',
  // Transform TypeScript files
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: {
          module: 'ESNext',
          moduleResolution: 'bundler'
        }
      }
    ]
  },

  // Tell Jest these extensions should be treated as ESM
  extensionsToTreatAsEsm: ['.ts', '.tsx'],

  // Handle .js extensions in import statements for TypeScript files
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },

  // Ignore compiled output
  testPathIgnorePatterns: ['/node_modules/', '/out/'],
  modulePathIgnorePatterns: ['<rootDir>/out/'],

  // Important for ES modules
  transformIgnorePatterns: ['/node_modules/(?!.*\\.mjs$)'],

  // Use .mjs extension for Jest config to indicate ESM
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node', 'mjs']
}
