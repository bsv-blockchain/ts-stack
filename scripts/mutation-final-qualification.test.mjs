import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import {
  makeTargetReceipt,
  verifyFullCampaign,
  loadCanonicalEvidence
} from './mutation-final-qualification.mjs'

const identity = {
  sourceSha: 'a'.repeat(40),
  runId: '17',
  runAttempt: '2',
  nodeVersion: 'v24.18.0',
  inputsDigest: 'inputs',
  targetsDigest: 'targets',
  targetIds: ['one', 'two']
}
const policy = {
  tool: { propertyRuns: 300, propertySeed: 3242026 },
  targets: ['one', 'two'].map(id => ({
    id,
    minimumScore: 90,
    maximumNoCoverage: 0,
    maximumInvalid: 0
  }))
}
const directory = '/tmp/ts-stack-mutation-evidence'
const sources = new Map([
  [
    'src/api.ts',
    'export const equal = (n: number) => n > 0\nexport const twice = (n: number) => n * 2\n'
  ],
  ['src/other.ts', 'export const positive = (n: number) => n >= 1\n'],
  ['src/types.ts', 'export interface Empty { value: string }\n']
])
const mutate = ['src/api.ts:1-1', 'src/other.ts', 'src/types.ts']
const inventory = JSON.parse(
  fs.readFileSync(
    new URL('./ci-integration/fixtures/mutation-inventory.json', import.meta.url),
    'utf8'
  )
)
const evidence = {
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
function report(statuses = ['Killed']) {
  const files = {}
  for (const [index, mutant] of inventory.entries()) {
    const file = (files[mutant.fileName] ??= { source: sources.get(mutant.fileName), mutants: [] })
    const { fileName: _fileName, ...result } = structuredClone(mutant)
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
function executionFor(reportBytes, targetId = 'one') {
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
const entry = (target, statuses, mode = 'full') => {
  const reportBytes = JSON.stringify(report(statuses))
  const executionBytes = executionFor(reportBytes, target)
  return {
    reportBytes,
    executionBytes,
    receipt: makeTargetReceipt(
      identity,
      target,
      reportBytes,
      policy,
      mode,
      evidence,
      executionBytes
    )
  }
}
const qualify = entries => verifyFullCampaign(identity, entries, policy, () => evidence)
const capture = value =>
  makeTargetReceipt(
    identity,
    'one',
    JSON.stringify(value),
    policy,
    'full',
    evidence,
    executionFor(JSON.stringify(value))
  )

test('complete exact-source campaigns preserve every target score, no-coverage and invalid gate', () => {
  const qualified = qualify([entry('two'), entry('one')])
  assert.equal(qualified.identity.sourceSha, identity.sourceSha)
  assert.equal(qualified.targetCount, 2)
  assert.throws(() => entry('one', ['NoCoverage']), /below|no-coverage/)
  assert.throws(() => entry('one', ['CompileError']), /invalid/)
  assert.throws(() => entry('one', ['Pending']), /Unknown/)
  assert.ok(inventory.length > 5)
})

test('missing, duplicate, extra and diagnostic targets never qualify a full campaign', () => {
  assert.throws(() => qualify([entry('one')]), /every canonical/)
  assert.throws(() => qualify([]), /every canonical/)
  assert.throws(() => qualify([entry('one'), entry('one'), entry('two')]), /Duplicate/)
  assert.throws(() => entry('extra'), /outside canonical/)
  assert.throws(() => qualify([entry('one'), entry('two', undefined, 'diagnostic')]), /Diagnostic/)
})

test('head, attempt, runtime, control inputs and modified receipts fail closed', () => {
  for (const field of [
    'sourceSha',
    'runId',
    'runAttempt',
    'nodeVersion',
    'inputsDigest',
    'targetsDigest'
  ]) {
    const entries = [entry('one'), entry('two')]
    entries[0].receipt.identity = { ...identity, [field]: 'different' }
    assert.throws(() => qualify(entries), /identity/)
  }
  const entries = [entry('one'), entry('two')]
  entries[0].reportBytes += '\n'
  assert.throws(() => qualify(entries), /changed|execution/)
  entries[0] = entry('one')
  entries[0].receipt.metrics.score = 99
  assert.throws(() => qualify(entries), /changed|execution/)
})

test('source bytes, missing mutant-bearing files and missing individual mutants fail closed', () => {
  for (const change of [
    value => {
      value.files['src/api.ts'].source += 'old bytes'
    },
    value => {
      delete value.files['src/other.ts']
    },
    value => {
      value.files['src/api.ts'].mutants.pop()
    }
  ]) {
    const value = report()
    change(value)
    assert.throws(() => capture(value), /source differs|inventory/)
  }
  assert.equal(report().files['src/types.ts'], undefined)
  assert.doesNotThrow(() => capture(report()))
})

test('execution configuration, target ranges, runner, schema and engine are independently bound', () => {
  for (const change of [
    value => {
      value.config.mutate = ['src/api.ts:1-1']
    },
    value => {
      value.config.jest.config.testMatch = ['subset.test.ts']
    },
    value => {
      value.config.concurrency = 1
    },
    value => {
      value.config.incremental = true
    },
    value => {
      value.config.ignoreStatic = true
    },
    value => {
      value.config.mutator.excludedMutations = ['EqualityOperator']
    },
    value => {
      value.framework.version = '9.5.0'
    },
    value => {
      value.schemaVersion = 'unknown'
    },
    value => {
      value.projectRoot += '/other'
    }
  ]) {
    const value = report()
    change(value)
    assert.throws(() => capture(value), /execution differs|schema or engine|project root/)
  }
})

test('IDs, positions, replacements and unsupported ignored mutants cannot fabricate inventory', () => {
  for (const change of [
    mutants => {
      mutants[1].id = mutants[0].id
    },
    mutants => {
      delete mutants[0].id
    },
    mutants => {
      mutants[0].location.start.line = 0
    },
    mutants => {
      mutants[0].mutatorName = ''
    },
    mutants => {
      mutants[0].replacement = 'different'
    },
    mutants => {
      mutants[0].status = 'Ignored'
      mutants[0].statusReason = 'not canonical'
    }
  ]) {
    const value = report()
    change(value.files['src/api.ts'].mutants)
    assert.throws(() => capture(value), /ID|structure|inventory/)
  }
})

test('actual reporter end-before-start field order preserves semantic mutant identity', () => {
  const value = report()
  for (const file of Object.values(value.files))
    for (const mutant of file.mutants) {
      const { start, end } = mutant.location
      mutant.location = { end, start }
    }
  assert.doesNotThrow(() => capture(value))
})

test('successful execution evidence binds the exact report, properties, run and runtime', () => {
  const reportBytes = JSON.stringify(report())
  for (const change of [
    value => {
      value.runAttempt = 'old'
    },
    value => {
      value.targetId = 'other'
    },
    value => {
      value.reportDigest = 'old'
    },
    value => {
      value.propertyEnvironment.FAST_CHECK_NUM_RUNS = '20'
    },
    value => {
      value.propertyEnvironment.FAST_CHECK_SEED = 'other'
    },
    value => {
      value.propertyEnvironment.FAST_CHECK_PATH = 'partial'
    }
  ]) {
    const value = JSON.parse(executionFor(reportBytes))
    change(value)
    assert.throws(
      () =>
        makeTargetReceipt(
          identity,
          'one',
          reportBytes,
          policy,
          'full',
          evidence,
          JSON.stringify(value)
        ),
      /execution|property/
    )
  }
  const replay = JSON.parse(executionFor(reportBytes))
  replay.propertyEnvironment.FAST_CHECK_PATH = 'partial'
  assert.equal(
    makeTargetReceipt(
      identity,
      'one',
      reportBytes,
      policy,
      'diagnostic',
      evidence,
      JSON.stringify(replay)
    ).mode,
    'diagnostic'
  )
})

test('canonical evidence loading bounds resource concurrency and propagates missing evidence', async () => {
  const ids = Array.from({ length: 33 }, (_, index) => String(index))
  let active = 0
  let peak = 0
  const results = await loadCanonicalEvidence(ids, async id => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise(resolve => setImmediate(resolve))
    active -= 1
    return `canonical-${id}`
  })
  assert.equal(peak, 4)
  assert.equal(results.size, ids.length)
  for (const id of ids) assert.equal(results.get(id), `canonical-${id}`)
  await assert.rejects(
    loadCanonicalEvidence(ids, async id => {
      if (id === '3') throw new Error('missing canonical source')
      return id
    }),
    /missing canonical source/
  )
})
