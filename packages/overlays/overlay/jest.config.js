import { createCoreOverlayTestProjects } from './jest.projects.mjs'

/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  projects: createCoreOverlayTestProjects(undefined, { rootDir: import.meta.dirname }),
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/**/__tests__/**',
    '!src/**/__tests/**'
  ]
}
