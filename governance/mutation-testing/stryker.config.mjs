import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { statSync } from 'node:fs'
import { buildMutationTargets } from './targets.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const targetName = process.env.TS_STACK_MUTATION_TARGET
const targets = buildMutationTargets(repositoryRoot)

const target = targets[targetName]

if (target === undefined) {
  throw new Error(
    `Unknown TS_STACK_MUTATION_TARGET ${JSON.stringify(targetName)}. Expected one of: ${Object.keys(
      targets
    ).join(', ')}`
  )
}

const expectedDirectory = resolve(repositoryRoot, target.packageDirectory)
const expectedStat = statSync(expectedDirectory)
const currentStat = statSync(process.cwd())
if (expectedStat.dev !== currentStat.dev || expectedStat.ino !== currentStat.ino) {
  throw new Error(
    `Mutation target ${targetName} must run from ${expectedDirectory}; received ${process.cwd()}`
  )
}

const reportDirectory = resolve(repositoryRoot, 'artifacts/mutation', targetName)

export default {
  testRunner: target.testRunner,
  plugins: [
    resolve(
      repositoryRoot,
      `node_modules/@stryker-mutator/${target.testRunner}-runner/dist/src/index.js`
    )
  ],
  coverageAnalysis: 'perTest',
  mutate: target.mutate,
  concurrency: 4,
  timeoutMS: 2_000,
  timeoutFactor: 3,
  cleanTempDir: 'always',
  ignorePatterns: ['coverage', 'dist', 'reports', 'artifacts', '.stryker-tmp'],
  reporters: ['clear-text', 'json'],
  jsonReporter: {
    fileName: resolve(reportDirectory, 'mutation.json')
  },
  thresholds: {
    high: 80,
    low: 60,
    break: null
  },
  ...target.runnerOptions
}
