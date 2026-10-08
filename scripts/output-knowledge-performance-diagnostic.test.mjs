import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  applicationDiagnosticSelection,
  diagnosticMayContinueValidation,
  readBoundedProfile,
  readFunctionEntries,
  summarizeFunctionEntries,
  summarizeCPUProfile,
  summarizePropertyExecution,
  triageDiagnostic
} from './output-knowledge-performance-diagnostic.mjs'

const countRoot = '/synthetic-repository'
const countSource = `${countRoot}/packages/sdk/src/overlay-tools/OutputProtocolJSON.ts`
const countFixture = (count = 3) => ({
  result: [
    {
      url: countSource,
      functions: [
        {
          functionName: 'visitOutputJSON',
          isBlockCoverage: true,
          ranges: [
            { startOffset: 10, endOffset: 100, count },
            { startOffset: 20, endOffset: 30, count: 99 }
          ]
        }
      ]
    },
    { url: 'file:///unowned/private-value.js', functions: [] }
  ],
  'source-map-cache': { private: { sourcesContent: ['PRIVATE-SOURCE-PAYLOAD'] } }
})

test('independent entry counts sum only outer ranges in fixed modules without source payloads', () => {
  const report = summarizeFunctionEntries([countFixture(3), countFixture(5)], countRoot, () => {})
  assert.equal(report.coverageFiles, 2)
  assert.deepEqual(report.rows, [
    {
      source: 'packages/sdk/src/overlay-tools/OutputProtocolJSON.ts',
      functionName: 'visitOutputJSON',
      startOffset: 10,
      endOffset: 100,
      entries: 8
    }
  ])
  assert.equal(report.timingCollected, false)
  assert.equal(report.fullFunctionalQualified, false)
  assert.equal(report.fullCampaignQualified, false)
  assert.equal(JSON.stringify(report).includes('PRIVATE'), false)
  assert.equal(JSON.stringify(report).includes('unowned'), false)
})

test('entry metadata refuses malformed identities, ranges, overflow and deadlines', () => {
  for (const alter of [
    fn => {
      fn.functionName = 'private\nvalue'
    },
    fn => {
      fn.isBlockCoverage = 'true'
    },
    fn => {
      fn.ranges = []
    },
    fn => {
      fn.ranges[0].count = -1
    },
    fn => {
      fn.ranges[0].count = Number.MAX_SAFE_INTEGER
    },
    fn => {
      fn.ranges[0].startOffset = 100
    },
    fn => {
      fn.ranges[1].endOffset = 101
    }
  ]) {
    const fixture = countFixture()
    alter(fixture.result[0].functions[0])
    assert.throws(() => summarizeFunctionEntries([fixture], countRoot, () => {}))
  }
  assert.throws(() => summarizeFunctionEntries([], countRoot, () => {}))
  assert.throws(() => summarizeFunctionEntries(Array(17).fill(countFixture()), countRoot, () => {}))
  assert.throws(() =>
    summarizeFunctionEntries(
      [countFixture(600000000), countFixture(600000000)],
      countRoot,
      () => {}
    )
  )
  assert.throws(() => summarizeFunctionEntries([{ result: [] }], countRoot, () => {}))
  assert.throws(
    () =>
      summarizeFunctionEntries([countFixture()], countRoot, () => {
        throw new Error('deadline')
      }),
    /deadline/
  )
})

test('entry-file collection rejects symlinks, unexpected names and oversized aggregates', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-function-entries-'))
  const file = path.join(directory, 'coverage-123-456-0.json')
  try {
    fs.writeFileSync(file, JSON.stringify(countFixture()))
    assert.equal(readFunctionEntries(directory, countRoot, () => {}).rows[0].entries, 3)
    fs.renameSync(file, path.join(directory, 'unexpected.json'))
    assert.throws(
      () => readFunctionEntries(directory, countRoot, () => {}),
      /function-count-file-name/
    )
    fs.renameSync(path.join(directory, 'unexpected.json'), file)
    fs.symlinkSync(file, path.join(directory, 'coverage-123-789-0.json'))
    assert.throws(() => readFunctionEntries(directory, countRoot, () => {}))
    fs.unlinkSync(path.join(directory, 'coverage-123-789-0.json'))
    fs.truncateSync(file, 64 * 1024 * 1024 + 1)
    assert.throws(
      () => readFunctionEntries(directory, countRoot, () => {}),
      /bounded metadata budget/
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('diagnostic triage distinguishes ordinary failures, synthetic faults, case bounds and oversized output', () => {
  const ordinary = triageDiagnostic(Buffer.from('Property interrupted after 116 tests'), 1)
  assert.equal(ordinary.knownNativeFaultMarker, false)
  assert.equal(ordinary.testCaseTimeoutMarker, false)
  assert.equal(ordinary.rawPayloadPrinted, false)
  assert.equal(
    triageDiagnostic(Buffer.from('synthetic SIGSEGV marker'), 0).knownNativeFaultMarker,
    true
  )
  assert.equal(triageDiagnostic(Buffer.alloc(0), 139).knownNativeFaultMarker, true)
  assert.equal(
    triageDiagnostic(Buffer.from('Exceeded timeout of 180000 ms'), 1).testCaseTimeoutMarker,
    true
  )
  assert.equal(triageDiagnostic(Buffer.alloc(16 * 1024 * 1024 + 1), 0).boundedTriageExceeded, true)
})

const safeMeasurement = {
  processGroupGone: true,
  timedOut: false,
  stopReason: null,
  signal: null,
  exitCode: 1,
  knownNativeFaultMarker: false,
  boundedTriageExceeded: false,
  testCaseTimeoutMarker: false
}

test('monotonic timing refusals retain every original supervisor admission guard', () => {
  for (const phase of [
    'monotonic-file-bound',
    'monotonic-summary',
    'function-count-file-bound',
    'function-count-summary'
  ]) {
    assert.equal(diagnosticMayContinueValidation(phase, safeMeasurement), true)
    for (const change of [
      { processGroupGone: false },
      { timedOut: true },
      { stopReason: 'source-changed' },
      { signal: 'SIGTERM' },
      { exitCode: 2 },
      { knownNativeFaultMarker: true },
      { boundedTriageExceeded: true },
      { testCaseTimeoutMarker: true }
    ])
      assert.equal(diagnosticMayContinueValidation(phase, { ...safeMeasurement, ...change }), false)
  }
  assert.equal(diagnosticMayContinueValidation('monotonic-bootstrap', safeMeasurement), false)
})

test('property metadata exposes only an exact scalar outcome/count and never infers passing runs', () => {
  for (const [line, outcome, completedCases] of [
    ['    Property interrupted after 163 tests\r\n', 'interrupted', 163],
    ['Error: Property failed after 1 tests\nCounterexample: private data', 'counterexample', 1],
    ['Property interrupted after 0 tests', 'interrupted', 0]
  ]) {
    const report = summarizePropertyExecution(Buffer.from(line), safeMeasurement)
    assert.deepEqual(report, { outcome, completedCases })
    assert.equal(JSON.stringify(report).includes('private data'), false)
  }
  assert.deepEqual(
    summarizePropertyExecution(Buffer.from('PASS suite'), { ...safeMeasurement, exitCode: 0 }),
    { outcome: 'passed', completedCases: null }
  )
})

test('ambiguous or noncanonical failure text supplies no property count', () => {
  for (const text of [
    'ordinary unrelated failure',
    'value: Property interrupted after 7 tests',
    'Property interrupted after 301 tests',
    'Property interrupted after 01 tests',
    'Property interrupted after 9007199254740992 tests',
    'Property interrupted after 10 tests\nProperty failed after 11 tests'
  ])
    assert.deepEqual(summarizePropertyExecution(Buffer.from(text), safeMeasurement), {
      outcome: 'other-failure',
      completedCases: null
    })
})

test('property metadata refuses every unsafe supervisor and independently retriages bounded bytes', () => {
  for (const change of [
    { processGroupGone: false },
    { timedOut: true },
    { stopReason: 'source-changed' },
    { signal: 'SIGTERM' },
    { exitCode: 2 },
    { knownNativeFaultMarker: true },
    { boundedTriageExceeded: true },
    { testCaseTimeoutMarker: true }
  ])
    assert.throws(
      () => summarizePropertyExecution(Buffer.from('PASS'), { ...safeMeasurement, ...change }),
      /Unsafe property execution metadata/
    )
  for (const bytes of [
    Buffer.from('synthetic SIGSEGV marker'),
    Buffer.from('Exceeded timeout of 180000 ms'),
    Buffer.alloc(16 * 1024 * 1024 + 1)
  ])
    assert.throws(
      () => summarizePropertyExecution(bytes, safeMeasurement),
      /Unsafe property execution metadata/
    )
})

const frame = (functionName, url, lineNumber) => ({ functionName, url, lineNumber })
const profile = () => ({
  nodes: [
    { id: 1, callFrame: frame('parent', 'file:///public/parent.mjs', 0), children: [2] },
    { id: 2, callFrame: frame('leaf\n', 'file:///public/leaf.mjs', 4) }
  ],
  samples: [1, 2, 2],
  timeDeltas: [1000, 2000, 3000],
  applicationValue: 'must never be included in the report'
})
test('CPU summaries retain self and inclusive time without raw profile or application fields', () => {
  const summary = summarizeCPUProfile(profile())
  assert.equal(summary.totalMilliseconds, 6)
  assert.deepEqual(summary.topSelf[0], {
    function: 'leaf?',
    source: 'file:///public/leaf.mjs',
    line: 5,
    selfMilliseconds: 5,
    inclusiveMilliseconds: 5
  })
  assert.equal(summary.topInclusive[0].function, 'parent')
  assert.equal(summary.topInclusive[0].inclusiveMilliseconds, 6)
  assert.equal(summary.rawProfilePrinted, false)
  assert.equal(summary.applicationValuesPrinted, false)
  assert.equal(JSON.stringify(summary).includes('must never'), false)
})

test('function timing combines separate call stacks without double counting recursive inclusive samples', () => {
  const leaf = frame('leaf', 'file:///public/leaf.mjs', 4)
  const summary = summarizeCPUProfile({
    nodes: [
      { id: 1, callFrame: frame('parent', 'file:///public/parent.mjs', 0), children: [2, 4] },
      { id: 2, callFrame: leaf, children: [3] },
      { id: 3, callFrame: leaf },
      { id: 4, callFrame: leaf }
    ],
    samples: [2, 3, 4],
    timeDeltas: [1000, 2000, 3000]
  })
  assert.equal(summary.totalMilliseconds, 6)
  assert.equal(summary.functions, 2)
  assert.deepEqual(summary.topSelfByFunction, [
    {
      function: 'leaf',
      source: 'file:///public/leaf.mjs',
      line: 5,
      selfMilliseconds: 6,
      inclusiveMilliseconds: 6
    }
  ])
  assert.equal(summary.topInclusiveByFunction.length, 2)
  assert.equal(
    summary.topInclusiveByFunction.every(row => row.inclusiveMilliseconds === 6),
    true
  )
  assert.equal(summary.topSelf.length, 3)
})

test('function aggregation keeps distinct sources and positions independently identified', () => {
  const summary = summarizeCPUProfile({
    nodes: [
      { id: 1, callFrame: frame('root', '', -1), children: [2, 3, 4] },
      { id: 2, callFrame: frame('same', 'file:///public/a.mjs', 4) },
      { id: 3, callFrame: frame('same', 'file:///public/b.mjs', 4) },
      { id: 4, callFrame: frame('same', 'file:///public/a.mjs', 5) }
    ],
    samples: [2, 3, 4],
    timeDeltas: [1000, 2000, 3000]
  })
  assert.equal(summary.functions, 4)
  assert.equal(summary.topSelfByFunction.length, 3)
  assert.equal(summary.topSelfByFunction[0].line, 6)
  assert.equal(summary.topSelfByFunction[1].source, 'file:///public/b.mjs')
  assert.equal(summary.topInclusiveByFunction[0].function, 'root')
  assert.equal(summary.topInclusiveByFunction[0].inclusiveMilliseconds, 6)
})

test('inconsistent, unknown and cyclic profile frames fail closed', () => {
  for (const mutate of [
    p => {
      p.timeDeltas.pop()
    },
    p => {
      p.samples[0] = 9
    },
    p => {
      p.timeDeltas[0] = -1
    },
    p => {
      p.nodes[1].id = 1
    },
    p => {
      p.nodes[1].children = [1]
    }
  ]) {
    const p = profile()
    mutate(p)
    assert.throws(() => summarizeCPUProfile(p))
  }
})

test('out-of-order timestamp deltas retain every paired observation and chronological duration', () => {
  const unordered = profile()
  unordered.timeDeltas = [3000, -1000, 4000]
  const summary = summarizeCPUProfile(unordered)
  const ordered = summarizeCPUProfile(profile())
  assert.equal(summary.samples, 3)
  assert.equal(summary.totalMilliseconds, 6)
  assert.equal(summary.negativeDeltas, 1)
  assert.equal(summary.reorderedSamples, 2)
  assert.deepEqual(summary.topSelf, ordered.topSelf)
  assert.deepEqual(summary.topInclusive, ordered.topInclusive)
  assert.deepEqual(summary.topSelfByFunction, ordered.topSelfByFunction)
  assert.deepEqual(summary.topInclusiveByFunction, ordered.topInclusiveByFunction)
  assert.equal(ordered.negativeDeltas, 0)
  assert.equal(ordered.reorderedSamples, 0)
})

test('nonfinite and before-start cumulative timestamps remain invalid, including after valid observations', () => {
  for (const deltas of [
    [1000, -1001, 3000],
    [1000, Number.POSITIVE_INFINITY, 3000]
  ]) {
    const invalid = profile()
    invalid.timeDeltas = deltas
    assert.throws(() => summarizeCPUProfile(invalid), /profile-time-delta/)
  }
})

test('fixed property and native HTTP diagnostics retain their original complete selectors and case controls', () => {
  const property = applicationDiagnosticSelection(),
    native = applicationDiagnosticSelection('native-http')
  assert.equal(property.kind, 'property')
  assert.equal(property.minimumPropertyRuns, 300)
  assert.equal(property.seed, 3242026)
  assert.equal(property.interruptAsFailureMilliseconds, 150000)
  assert.equal(native.kind, 'native-http')
  assert.equal(native.minimumPropertyRuns, null)
  assert.equal(native.seed, null)
  assert.equal(native.interruptAsFailureMilliseconds, null)
  assert.equal(property.selector, 'test/private-purchase-alias-disclosure.property.test.ts')
  assert.equal(property.packageDirectory, 'packages/application/output-knowledge')
  assert.equal(property.profile, 'property.cpuprofile')
  assert.equal(property.deadlineSeconds, 210)
  assert.equal(property.testCaseMilliseconds, 180000)
  assert.equal(property.requiresMongo, false)
  assert.equal(
    native.selector,
    'src/__tests__/PrivatePurchaseProfileAliasNative.integration.test.ts'
  )
  assert.equal(native.packageDirectory, 'packages/overlays/overlay-express')
  assert.equal(native.deadlineSeconds, 600)
  assert.equal(native.testCaseMilliseconds, 120000)
  assert.equal(native.nativeCases, 4)
  assert.equal(native.requiresMongo, true)
  assert.notEqual(native.outputPrefix, property.outputPrefix)
  assert.ok(Object.isFrozen(property) && Object.isFrozen(native))
  const source = fs.readFileSync(
    new URL('../packages/overlays/overlay-express/' + native.selector, import.meta.url),
    'utf8'
  )
  assert.equal(source.match(/}, 120000\)/g).length, 4)
  for (const kind of ['unknown', '../test', null, false])
    assert.throws(
      () => applicationDiagnosticSelection(kind),
      /Unknown application diagnostic selector/
    )
})

test('the additive coordinator diagnostic binds the other original property with identical limits', () => {
  const disclosure = applicationDiagnosticSelection(),
    coordinator = applicationDiagnosticSelection('coordinator-property')
  assert.deepEqual(coordinator, {
    ...disclosure,
    kind: 'coordinator-property',
    selector: 'test/private-purchase-alias-coordinator.property.test.ts',
    profile: 'coordinator-property.cpuprofile',
    outputPrefix: 'performance-diagnostic-coordinator'
  })
  assert.ok(Object.isFrozen(coordinator))
  const source = fs.readFileSync(
    new URL('../' + coordinator.packageDirectory + '/' + coordinator.selector, import.meta.url),
    'utf8'
  )
  assert.match(source, /MIN_PROPERTY_RUNS = 300/)
  assert.match(source, /seed : 3242026/)
  assert.match(source, /interruptAfterTimeLimit: 150000/)
  assert.match(source, /markInterruptAsFailure: true/)
  assert.match(source, /}, 180000\)/)
})

test('hosted timing is explicitly opt-in and preserves the ordinary artifact and coverage gates', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  assert.match(workflow, /application-performance-diagnostics:\n(?:.*\n){2}        default: false/)
  const measure = workflow.indexOf(
    '      - name: Measure the unchanged application property on hosted Linux'
  )
  const upload = workflow.indexOf('      - name: Preserve bounded application function timing')
  const native = workflow.indexOf(
    '      - name: Measure the unchanged native purchase HTTP composition on hosted Linux'
  )
  const coordinator = workflow.indexOf(
    '      - name: Measure the unchanged application coordinator property on hosted Linux'
  )
  const complete = workflow.indexOf(
    '      - name: Compile documentation examples against exact package tarballs'
  )
  assert.ok(measure > 0 && upload > measure && complete > upload)
  assert.ok(native > measure && native < upload)
  assert.ok(coordinator > native && coordinator < upload)
  const optional = workflow.slice(measure, complete)
  assert.equal(
    optional.match(
      /github.event_name == 'workflow_dispatch' && inputs.application-performance-diagnostics/g
    ).length,
    4
  )
  assert.equal(
    optional.match(
      /github.event_name == 'pull_request' && contains\(github.event.pull_request.labels.\*.name, 'ci:application-performance-diagnostics'\)/g
    ).length,
    4
  )
  assert.match(
    optional,
    /run: node scripts\/output-knowledge-performance-diagnostic\.mjs --native-http/
  )
  assert.match(optional, /MONGOMS_DOWNLOAD_DIR: \$\{\{ runner.temp \}\}\/mongodb-binaries/)
  assert.match(
    optional,
    /run: node scripts\/output-knowledge-performance-diagnostic\.mjs --coordinator/
  )
  assert.match(optional, /path: \.coverage-output\/performance-diagnostic-\*\//)
  assert.equal(optional.includes('property.cpuprofile'), false)
  assert.ok(workflow.slice(complete).includes('node scripts/output-knowledge-coverage.mjs collect'))
  assert.match(workflow, /coverage-other/)
})

test('only a safe drained timing refusal can continue the independent complete artifact validation', () => {
  const safe = {
    processGroupGone: true,
    timedOut: false,
    stopReason: null,
    signal: null,
    exitCode: 1,
    knownNativeFaultMarker: false,
    boundedTriageExceeded: false,
    testCaseTimeoutMarker: false
  }
  assert.equal(diagnosticMayContinueValidation('profile-summary', safe), true)
  assert.equal(diagnosticMayContinueValidation('profile-json', { ...safe, exitCode: 0 }), true)
  for (const phase of [
    'sqlite-health',
    'post-property-source-guard',
    'unchanged-property-with-coverage',
    'final-source-guard'
  ])
    assert.equal(diagnosticMayContinueValidation(phase, safe), false)
  for (const change of [
    { processGroupGone: false },
    { timedOut: true },
    { stopReason: 'operator-cancelled' },
    { signal: 'SIGTERM' },
    { exitCode: 2 },
    { knownNativeFaultMarker: true },
    { boundedTriageExceeded: true },
    { testCaseTimeoutMarker: true }
  ])
    assert.equal(diagnosticMayContinueValidation('profile-summary', { ...safe, ...change }), false)
  assert.equal(diagnosticMayContinueValidation('profile-summary', undefined), false)
})

test('profile reads use the opened descriptor and refuse oversized or changed files and symlinks', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pure-profile-file-')),
    file = path.join(directory, 'profile.json'),
    link = path.join(directory, 'link.json')
  try {
    const bytes = JSON.stringify(profile())
    fs.writeFileSync(file, bytes)
    const report = { phase: 'profile-file-bound' }
    assert.deepEqual(
      readBoundedProfile(file, 65536, report, () => {}),
      profile()
    )
    assert.equal(report.profileBytes, Buffer.byteLength(bytes))
    assert.equal(report.phase, 'profile-json')
    assert.throws(() => readBoundedProfile(file, 1, {}, () => {}), /bounded metadata budget/)
    fs.symlinkSync(file, link)
    assert.throws(() => readBoundedProfile(link, 65536, {}, () => {}))
    assert.throws(() => readBoundedProfile(directory, 65536, {}, () => {}), /profile-file-kind/)
    let checks = 0
    assert.throws(
      () =>
        readBoundedProfile(file, 65536, {}, () => {
          if (++checks === 2) fs.appendFileSync(file, ' ')
        }),
      /Profile changed during bounded read/
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
