import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  applicationDiagnosticSelection,
  diagnosticMayContinueValidation,
  readBoundedProfile,
  summarizeCPUProfile,
  triageDiagnostic
} from './output-knowledge-performance-diagnostic.mjs'

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
  const complete = workflow.indexOf(
    '      - name: Compile documentation examples against exact package tarballs'
  )
  assert.ok(measure > 0 && upload > measure && complete > upload)
  assert.ok(native > measure && native < upload)
  const optional = workflow.slice(measure, complete)
  assert.equal(
    optional.match(
      /github.event_name == 'workflow_dispatch' && inputs.application-performance-diagnostics/g
    ).length,
    3
  )
  assert.equal(
    optional.match(
      /github.event_name == 'pull_request' && contains\(github.event.pull_request.labels.\*.name, 'ci:application-performance-diagnostics'\)/g
    ).length,
    3
  )
  assert.match(
    optional,
    /run: node scripts\/output-knowledge-performance-diagnostic\.mjs --native-http/
  )
  assert.match(optional, /MONGOMS_DOWNLOAD_DIR: \$\{\{ runner.temp \}\}\/mongodb-binaries/)
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
