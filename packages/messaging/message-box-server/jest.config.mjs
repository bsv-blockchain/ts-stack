// jest.config.mjs - ES Module version of Jest config
export default {
  // Setup file to provide globals and env vars
  setupFilesAfterEnv: ['./jest.setup.mjs'],
  // Use Node environment
  testEnvironment: 'node',
  // Force exit after tests complete (module-level knex pools stay open)
  forceExit: true,
  
  // Transform TypeScript files
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
      },
    ],
  },
  
  // Tell Jest these extensions should be treated as ESM
  extensionsToTreatAsEsm: ['.ts', '.tsx'],
  
  // Handle .js extensions in import statements for TypeScript files
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  
  // Ignore compiled output
  testPathIgnorePatterns: ['/node_modules/', '/out/'],
  
  // Important for ES modules
  transformIgnorePatterns: [
    '/node_modules/(?!.*\\.mjs$)'
  ],
  
  // Use .mjs extension for Jest config to indicate ESM
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node', 'mjs'],
};
