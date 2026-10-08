import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  applicationDiagnosticSelection,
  nativePreparationMayContinue,
  diagnosticMayContinueValidation,
  functionEntryRefusal,
  readBoundedProfile,
  readFunctionEntries,
  summarizeFunctionEntries,
  summarizeCPUProfile,
  summarizePropertyExecution,
  triageDiagnostic
} from './output-knowledge-performance-diagnostic.mjs'

const countRoot = '/synthetic-repository'
const countSource = `${countRoot}/packages/sdk/src/overlay-tools/OutputProtocolJSON.ts`
const countFixture = (entries = 3) => ({
  [countSource]: {
    path: countSource,
    fnMap: {
      0: {
        name: 'visitOutputJSON',
        decl: { start: { line: 1, column: 10 }, end: { line: 5, column: 4 } },
        loc: { start: { line: 1, column: 10 }, end: { line: 5, column: 4 } }
      },
      1: {
        name: '(anonymous_1)',
        decl: { start: { line: 6, column: 0 }, end: { line: 6, column: 10 } },
        loc: { start: { line: 6, column: 0 }, end: { line: 6, column: 10 } }
      }
    },
    f: { 0: entries, 1: 0 },
    b: { 0: [99, 99] },
    inputSourceMap: { sourcesContent: ['PRIVATE-SOURCE-PAYLOAD'] }
  },
  '/unowned/private-value.js': { private: 'PRIVATE' }
})

test('entry refusal classification reveals fixed reasons without exception payloads', () => {
  assert.equal(
    functionEntryRefusal(new Error('function-count-shape\nPRIVATE')),
    'function-count-shape'
  )
  assert.equal(
    functionEntryRefusal(Object.assign(new Error('PRIVATE'), { code: 'ENOENT' })),
    'function-count-absent'
  )
  assert.equal(
    functionEntryRefusal(Object.assign(new Error('PRIVATE'), { code: 'ELOOP' })),
    'function-count-file-access'
  )
  assert.equal(functionEntryRefusal(new Error('PRIVATE')), 'unclassified-refusal')
  assert.equal(functionEntryRefusal(null), 'unclassified-refusal')
})

test('entry counts preserve original Jest counters and positions without source payloads', () => {
  const report = summarizeFunctionEntries(countFixture(5), countRoot, () => {})
  assert.equal(report.coverageFiles, 1)
  assert.equal(report.countSemantics, 'original-jest-istanbul-function-entries')
  assert.equal(report.sourcePositions, true)
  assert.equal(report.positionSemantics, 'original-function-declaration-start')
  assert.deepEqual(report.rows, [
    {
      source: 'packages/sdk/src/overlay-tools/OutputProtocolJSON.ts',
      functionId: 0,
      functionName: 'visitOutputJSON',
      declaration: { line: 1, column: 10 },
      entries: 5
    },
    {
      source: 'packages/sdk/src/overlay-tools/OutputProtocolJSON.ts',
      functionId: 1,
      functionName: '(anonymous_1)',
      declaration: { line: 6, column: 0 },
      entries: 0
    }
  ])
  assert.equal(report.timingCollected, false)
  assert.equal(report.fullFunctionalQualified, false)
  assert.equal(report.fullCampaignQualified, false)
  assert.equal(JSON.stringify(report).includes('PRIVATE'), false)
  assert.equal(JSON.stringify(report).includes('unowned'), false)
})

test('source-map body gaps do not invent declaration positions or function entries', () => {
  const fixture = countFixture(7)
  fixture[countSource].fnMap[0].loc.end.column = null
  fixture[countSource].fnMap[0].decl.end.column = null
  const report = summarizeFunctionEntries(fixture, countRoot, () => {})
  assert.equal(report.rows[0].entries, 7)
  assert.deepEqual(report.rows[0].declaration, fixture[countSource].fnMap[0].decl.start)
  assert.equal(Object.hasOwn(report.rows[0], 'end'), false)
})

test('entry metadata refuses malformed identities, positions, counts and deadlines', () => {
  for (const alter of [
    data => {
      data.fnMap[0].name = 'private\nvalue'
    },
    data => {
      data.f[0] = -1
    },
    data => {
      data.f[0] = Number.MAX_SAFE_INTEGER
    },
    data => {
      data.fnMap[0].decl.start.line = 0
    },
    data => {
      data.fnMap[0].decl.start.column = null
    },
    data => {
      data.fnMap[0].decl.start.column = -1
    },
    data => {
      data.path = '/unowned/private-value.js'
    },
    data => {
      delete data.f[0]
    },
    data => {
      data.f[2] = 0
    },
    data => {
      data.fnMap['01'] = data.fnMap[0]
      data.f['01'] = 1
    }
  ]) {
    const fixture = countFixture()
    alter(fixture[countSource])
    assert.throws(() => summarizeFunctionEntries(fixture, countRoot, () => {}))
  }
  for (const invalid of [null, [], {}, { '/unowned/value.js': {} }])
    assert.throws(() => summarizeFunctionEntries(invalid, countRoot, () => {}))
  assert.throws(
    () =>
      summarizeFunctionEntries(countFixture(), countRoot, () => {
        throw new Error('deadline')
      }),
    /deadline/
  )
})

test('existing coverage collection rejects absent reports, symlinks and oversized bytes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-function-entries-'))
  const file = path.join(directory, 'coverage-final.json'),
    other = path.join(directory, 'other.json')
  try {
    fs.writeFileSync(file, JSON.stringify(countFixture()))
    assert.equal(readFunctionEntries(directory, countRoot, () => {}).rows[0].entries, 3)
    fs.renameSync(file, other)
    assert.throws(() => readFunctionEntries(directory, countRoot, () => {}))
    fs.symlinkSync(other, file)
    assert.throws(() => readFunctionEntries(directory, countRoot, () => {}))
    fs.unlinkSync(file)
    fs.renameSync(other, file)
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

test('identical duplicate property summaries retain only their fixed scalar outcome', () => {
  for (const [text, outcome, completedCases] of [
    [
      'Property interrupted after 209 tests\nError: Property interrupted after 209 tests',
      'interrupted',
      209
    ],
    [
      'Property failed after 1 tests\nCounterexample: private data\n    Property failed after 1 tests',
      'counterexample',
      1
    ],
    [
      'Property interrupted after 300 tests\nProperty interrupted after 300 tests',
      'interrupted',
      300
    ]
  ]) {
    const report = summarizePropertyExecution(Buffer.from(text), safeMeasurement)
    assert.deepEqual(report, { outcome, completedCases })
    assert.equal(JSON.stringify(report).includes('private data'), false)
  }
})

test('duplicate property summaries refuse mismatched counts, outcomes, excess reports and successful exits', () => {
  for (const text of [
    'Property interrupted after 10 tests\nProperty interrupted after 11 tests',
    'Property interrupted after 10 tests\nProperty failed after 10 tests',
    'Property failed after 1 tests\nProperty failed after 1 tests\nProperty failed after 1 tests',
    'Property interrupted after 301 tests\nProperty interrupted after 301 tests'
  ])
    assert.deepEqual(summarizePropertyExecution(Buffer.from(text), safeMeasurement), {
      outcome: 'other-failure',
      completedCases: null
    })
  assert.deepEqual(
    summarizePropertyExecution(
      Buffer.from('Property interrupted after 10 tests\nProperty interrupted after 10 tests'),
      { ...safeMeasurement, exitCode: 0 }
    ),
    { outcome: 'other-failure', completedCases: null }
  )
})

test('cold-cache preparation refuses every unsafe result and cannot accept an ordinary failure', () => {
  const success = {
    exitCode: 0,
    signal: null,
    processGroupGone: true,
    timedOut: false,
    stopReason: null,
    knownNativeFaultMarker: false,
    boundedTriageExceeded: false,
    testCaseTimeoutMarker: false
  }
  assert.equal(nativePreparationMayContinue(success), true)
  for (const change of [
    { exitCode: 1 },
    { exitCode: null },
    { signal: 'SIGTERM' },
    { processGroupGone: false },
    { timedOut: true },
    { stopReason: 'source-changed' },
    { knownNativeFaultMarker: true },
    { boundedTriageExceeded: true },
    { testCaseTimeoutMarker: true }
  ])
    assert.equal(nativePreparationMayContinue({ ...success, ...change }), false)
  assert.equal(nativePreparationMayContinue(undefined), false)
  const workflow = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'),
    preparation = workflow.indexOf(
      '      - name: Prepare the fixed Mongo binary before optional measurement'
    ),
    measure = workflow.indexOf(
      '      - name: Measure the unchanged application property on hosted Linux'
    ),
    restore = workflow.indexOf(
      '      - name: Restore the fixed Mongo binary for optional native diagnostics'
    )
  assert.ok(restore < preparation && preparation < measure)
  assert.match(
    workflow.slice(preparation, measure),
    /MONGOMS_DOWNLOAD_DIR: \$\{\{ runner.temp \}\}\/mongodb-binaries/
  )
  assert.match(
    workflow.slice(preparation, measure),
    /run: node scripts\/output-knowledge-performance-diagnostic\.mjs --prepare-native-runtime/
  )
})
