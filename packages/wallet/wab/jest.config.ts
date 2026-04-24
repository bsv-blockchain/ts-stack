import type { Config } from '@jest/types';

const config: Config.InitialOptions = {
    verbose: true,
    testEnvironment: 'node',
    preset: 'ts-jest',
    roots: ['<rootDir>/src'],
    testRegex: '(/__tests__/.*|(\\.|/)(test|spec))\\.ts$',
    globalSetup: '<rootDir>/jest.globalSetup.ts',
    setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
    transform: {
        '^.+\\.ts$': 'ts-jest'
    },
    moduleFileExtensions: ['ts', 'js', 'json'],
    collectCoverage: false,
    coverageDirectory: 'coverage',
    collectCoverageFrom: [
        'src/**/*.ts',
        '!src/**/*.test.ts',
        '!src/**/*.spec.ts',
        '!src/__tests__/**',
        '!src/server.ts'
    ],
    testTimeout: 30000
};

export default config;
