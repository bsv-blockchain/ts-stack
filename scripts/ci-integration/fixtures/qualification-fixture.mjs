import fs from 'node:fs'
import { createHash } from 'node:crypto'
export const identity = {
  sourceSha: 'a'.repeat(40),
  runId: '17',
  runAttempt: '2',
  nodeVersion: 'v24.18.0',
  inputsDigest: 'inputs',
  targetsDigest: 'targets',
  targetIds: ['one', 'two']
}
export const policy = {
  tool: { propertyRuns: 300, propertySeed: 3242026 },
  targets: ['one', 'two'].map(id => ({
    id,
    minimumScore: 90,
    maximumNoCoverage: 0,
    maximumInvalid: 0
  }))
}
const directory = '/canonical/mutation-evidence'
const sources = new Map([
  [
    'src/api.ts',
    'export const equal = (n: number) => n > 0\nexport const twice = (n: number) => n * 2\n'
  ],
  ['src/other.ts', 'export const positive = (n: number) => n >= 1\n'],
  ['src/types.ts', 'export interface Empty { value: string }\n']
])
const mutate = ['src/api.ts:1-1', 'src/other.ts', 'src/types.ts']
export const inventory = JSON.parse(
  fs.readFileSync(new URL('./mutation-inventory.json', import.meta.url), 'utf8')
)
export const evidence = {
  sources,
  mutants: inventory,
  projectRoot: directory,
  config: {
    mutate,
    testRunner: 'jest',
    coverageAnalysis: 'perTest',
    concurrency: 4,
    incremental: false,
    ignoreStatic: false,
    mutator: { excludedMutations: [], plugins: null },
    jest: { config: { testMatch: ['<rootDir>/tests/*.test.ts'] } }
  }
}
export function report(statuses = ['Killed']) {
  const files = {}
  for (const [index, mutant] of inventory.entries()) {
    const file = (files[mutant.fileName] ??= { source: sources.get(mutant.fileName), mutants: [] })
    const result = structuredClone(mutant)
    delete result.fileName
    file.mutants.push({ ...result, status: statuses[index] ?? 'Killed' })
  }
  return {
    schemaVersion: '1.0',
    framework: { name: 'StrykerJS', version: '9.6.1' },
    projectRoot: directory,
    config: structuredClone(evidence.config),
    files
  }
}
export function executionFor(reportBytes, targetId = 'one') {
  return JSON.stringify({
    targetId,
    sourceSha: identity.sourceSha,
    runId: identity.runId,
    runAttempt: identity.runAttempt,
    nodeVersion: identity.nodeVersion,
    propertyEnvironment: {
      FAST_CHECK_NUM_RUNS: '300',
      FAST_CHECK_SEED: '3242026',
      FAST_CHECK_PATH: ''
    },
    reportDigest: createHash('sha256').update(reportBytes).digest('hex')
  })
}
