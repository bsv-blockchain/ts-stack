import { createOverlayTestProjects, overlayTestIgnorePatterns } from './jest-projects.config.mjs'

/** Ordinary and private integrations retain their own module semantics in one complete campaign. */
export default {
  projects: createOverlayTestProjects(),
  testPathIgnorePatterns: overlayTestIgnorePatterns,
  modulePathIgnorePatterns: ['<rootDir>/dist/', String.raw`<rootDir>/\.stryker-tmp/`],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/**/__tests__/**',
    '!src/generalGuide.md.ts'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html']
}
