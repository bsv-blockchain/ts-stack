import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
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

test('hosted timing is explicitly opt-in and preserves the ordinary artifact and coverage gates', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  assert.match(workflow, /application-performance-diagnostics:\n(?:.*\n){2}        default: false/)
  const measure = workflow.indexOf(
    '      - name: Measure the unchanged application property on hosted Linux'
  )
  const upload = workflow.indexOf('      - name: Preserve bounded application function timing')
  const complete = workflow.indexOf(
    '      - name: Compile documentation examples against exact package tarballs'
  )
  assert.ok(measure > 0 && upload > measure && complete > upload)
  const optional = workflow.slice(measure, complete)
  assert.equal(
    optional.match(
      /github.event_name == 'workflow_dispatch' && inputs.application-performance-diagnostics/g
    ).length,
    2
  )
  assert.equal(
    optional.match(
      /github.event_name == 'pull_request' && contains\(github.event.pull_request.labels.\*.name, 'ci:application-performance-diagnostics'\)/g
    ).length,
    2
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
