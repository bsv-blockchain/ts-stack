import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  assertLocalExecution,
  readLocalPackets,
  trackedSourceDigest,
  validateLocalIdentity,
  verifyLocalRows
} from './local-mutation-qualification.mjs'
import {
  makeTargetReceipt,
  qualificationIdentity,
  verifyFullCampaign
} from './mutation-final-qualification.mjs'
import {
  evidence,
  executionFor,
  policy,
  report
} from './ci-integration/fixtures/qualification-fixture.mjs'

const digest = value => createHash('sha256').update(value).digest('hex')
const matrix = ['one', 'two'].map(target => ({ target, partition: 'whole' }))
const identity = {
  origin: 'local',
  runId: '',
  runAttempt: '',
  localRunId: 'b5b6b452-3a48-4cb3-908e-f30f7d07d37d',
  localAttempt: 1,
  sourceSha: 'a'.repeat(40),
  sourceTree: 'b'.repeat(40),
  nodeVersion: 'v24.22.1',
  nodeExecutable: '/opt/node/bin/node',
  nodeExecutableDigest: 'c'.repeat(64),
  platform: 'linux',
  arch: 'arm64',
  trackedCount: 3,
  sourceDigest: 'd'.repeat(64),
  runtimeDigest: 'e'.repeat(64),
  inputsDigest: digest(
    JSON.stringify({ trackedCount: 3, sourceDigest: 'd'.repeat(64), runtimeDigest: 'e'.repeat(64) })
  ),
  targetsDigest: '1'.repeat(64),
  matrixDigest: digest(JSON.stringify(matrix)),
  targetIds: ['one', 'two']
}
function packet(row = matrix[0], statuses) {
  const reportBytes = JSON.stringify(report(statuses))
  const executionBytes = JSON.stringify({
    ...JSON.parse(executionFor(reportBytes, row.target)),
    runId: '',
    runAttempt: '',
    partitionId: row.partition
  })
  return {
    row,
    reportBytes,
    executionBytes,
    observation: {
      kind: 'bounded-local-mutation-execution',
      localRunId: identity.localRunId,
      localAttempt: identity.localAttempt,
      sourceSha: identity.sourceSha,
      sourceTree: identity.sourceTree,
      nodeVersion: identity.nodeVersion,
      targetId: row.target,
      partitionId: row.partition,
      argv: [
        identity.nodeExecutable,
        'scripts/mutation-testing.mjs',
        '--target',
        row.target,
        '--partition',
        row.partition
      ],
      exitCode: 0,
      signal: null,
      processGroup: 123,
      processGroupGone: true,
      seconds: 10,
      deadlineSeconds: 60,
      timedOut: false,
      knownNativeFaultMarker: false,
      boundedTriageExceeded: false,
      testCaseTimeoutMarker: false,
      rawPayloadPrinted: false,
      beforeSourceDigest: identity.sourceDigest,
      afterSourceDigest: identity.sourceDigest,
      beforeRuntimeDigest: identity.runtimeDigest,
      afterRuntimeDigest: identity.runtimeDigest,
      reportDigest: digest(reportBytes),
      executionDigest: digest(executionBytes)
    }
  }
}
const assertPacket = value =>
  assertLocalExecution(
    identity,
    value.row,
    value.observation,
    value.reportBytes,
    value.executionBytes
  )
const inspect = (row, value) =>
  makeTargetReceipt(
    identity,
    row.target,
    value.reportBytes,
    policy,
    'full',
    evidence,
    value.executionBytes
  )

test('local qualification requires complete canonical rows and preserves the existing inventory/score gate', () => {
  const receipts = []
  const packets = matrix.map(row => packet(row))
  verifyLocalRows(identity, matrix, packets, (row, value) =>
    receipts.push({ ...value, receipt: inspect(row, value) })
  )
  assert.equal(verifyFullCampaign(identity, receipts, policy, () => evidence).targetCount, 2)
  assert.throws(() => verifyLocalRows(identity, matrix, packets.slice(1), inspect), /Incomplete/)
  assert.throws(
    () => verifyLocalRows(identity, matrix, [packets[0], packets[0]], inspect),
    /duplicate/
  )
  assert.throws(
    () =>
      verifyLocalRows(identity, matrix, [packet({ target: 'extra', partition: 'whole' })], inspect),
    /Unknown/
  )
  assert.throws(
    () =>
      verifyLocalRows(identity, matrix, [packet(matrix[0], ['NoCoverage']), packets[1]], inspect),
    /no-coverage|below/
  )
  assert.throws(
    () =>
      verifyLocalRows(identity, matrix, [packet(matrix[0], ['CompileError']), packets[1]], inspect),
    /invalid/
  )
})

test('a local identity cannot impersonate a hosted run or accept a different platform', () => {
  assert.equal(validateLocalIdentity(identity), identity)
  for (const [field, value] of [
    ['origin', 'github'],
    ['runId', '17'],
    ['runAttempt', '2'],
    ['localRunId', '17'],
    ['localAttempt', 0],
    ['platform', 'darwin'],
    ['arch', 'unknown'],
    ['targetIds', ['two', 'one']],
    ['targetIds', ['one', 'one']],
    ['sourceTree', 'invalid'],
    ['runtimeDigest', 'invalid']
  ])
    assert.throws(() => validateLocalIdentity({ ...identity, [field]: value }), undefined, field)
  assert.throws(
    () =>
      qualificationIdentity(
        process.cwd(),
        {
          GITHUB_SHA: execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], {
            encoding: 'utf8'
          }).trim(),
          GITHUB_RUN_ID: identity.localRunId,
          GITHUB_RUN_ATTEMPT: '1'
        },
        {}
      ),
    /Missing immutable GITHUB_RUN_ID/
  )
})

test('drain, deadline, process faults and all source/runtime/identity bindings fail closed', () => {
  for (const [field, value] of [
    ['localRunId', 'c'.repeat(36)],
    ['localAttempt', 2],
    ['sourceSha', 'b'.repeat(40)],
    ['sourceTree', 'a'.repeat(40)],
    ['nodeVersion', 'v24.17.0'],
    ['targetId', 'two'],
    ['partitionId', 'other'],
    ['argv', []],
    ['exitCode', 1],
    ['signal', 'SIGTERM'],
    ['processGroup', 0],
    ['processGroupGone', false],
    ['seconds', 60],
    ['seconds', NaN],
    ['deadlineSeconds', 0],
    ['timedOut', true],
    ['knownNativeFaultMarker', true],
    ['boundedTriageExceeded', true],
    ['testCaseTimeoutMarker', true],
    ['rawPayloadPrinted', true],
    ['beforeSourceDigest', '0'.repeat(64)],
    ['afterSourceDigest', '0'.repeat(64)],
    ['beforeRuntimeDigest', '0'.repeat(64)],
    ['afterRuntimeDigest', '0'.repeat(64)],
    ['reportDigest', '0'.repeat(64)],
    ['executionDigest', '0'.repeat(64)]
  ]) {
    const valueToCheck = packet()
    valueToCheck.observation[field] = value
    assert.throws(() => assertPacket(valueToCheck), undefined, field)
  }
  assert.doesNotThrow(() => assertPacket(packet()))
})

test('raw successful execution and full property settings are independently checked', () => {
  for (const change of [
    value => {
      value.runId = '17'
    },
    value => {
      value.partitionId = 'different'
    },
    value => {
      value.propertyEnvironment.FAST_CHECK_NUM_RUNS = '299'
    },
    value => {
      value.propertyEnvironment.FAST_CHECK_SEED = '1'
    },
    value => {
      value.propertyEnvironment.FAST_CHECK_PATH = '0:0'
    }
  ]) {
    const value = packet()
    const execution = JSON.parse(value.executionBytes)
    change(execution)
    value.executionBytes = JSON.stringify(execution)
    value.observation.executionDigest = digest(value.executionBytes)
    assert.throws(() => {
      assertPacket(value)
      inspect(value.row, value)
    })
  }
  const value = packet()
  const changed = JSON.parse(value.reportBytes)
  changed.files['src/api.ts'].mutants.pop()
  value.reportBytes = JSON.stringify(changed)
  const execution = JSON.parse(value.executionBytes)
  execution.reportDigest = digest(value.reportBytes)
  value.executionBytes = JSON.stringify(execution)
  Object.assign(value.observation, {
    reportDigest: digest(value.reportBytes),
    executionDigest: digest(value.executionBytes)
  })
  assert.throws(() => inspect(value.row, value), /inventory/)
})

test('raw packet inventory rejects missing, extra, traversing and symlinked evidence', () => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'local-mutation-packets-'))
  try {
    for (const row of matrix) {
      const value = packet(row)
      const location = path.join(directory, row.target)
      fs.mkdirSync(location)
      fs.writeFileSync(path.join(location, 'mutation.json'), value.reportBytes)
      fs.writeFileSync(path.join(location, 'execution.json'), value.executionBytes)
      fs.writeFileSync(
        path.join(location, 'local-execution.json'),
        JSON.stringify(value.observation)
      )
    }
    assert.equal(readLocalPackets(directory, matrix).length, 2)
    const filename = path.join(directory, 'one', 'local-execution.json')
    const original = fs.readFileSync(filename)
    fs.unlinkSync(filename)
    assert.throws(() => readLocalPackets(directory, matrix), /Missing/)
    fs.symlinkSync(path.join(directory, 'two', 'local-execution.json'), filename)
    assert.throws(() => readLocalPackets(directory, matrix), /Symlinks/)
    fs.unlinkSync(filename)
    fs.writeFileSync(filename, original)
    fs.writeFileSync(path.join(directory, 'extra.json'), '{}')
    assert.throws(() => readLocalPackets(directory, matrix), /Unknown/)
    assert.throws(
      () => readLocalPackets(directory, [{ target: '../other', partition: 'whole' }]),
      /component/
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('source closure covers every tracked file and refuses uncommitted tracked changes', () => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'local-mutation-source-'))
  const git = (...args) => execFileSync('/usr/bin/git', args, { cwd: directory })
  const commit = () => {
    git('add', '.')
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'Fixture'
    )
  }
  try {
    fs.writeFileSync(path.join(directory, 'source.ts'), 'export const n = 1\n')
    fs.writeFileSync(path.join(directory, 'controller.py'), 'print(1)\n')
    git('init', '--quiet')
    commit()
    const before = trackedSourceDigest(directory)
    assert.equal(before.trackedCount, 2)
    fs.writeFileSync(path.join(directory, 'controller.py'), 'print(2)\n')
    assert.throws(() => trackedSourceDigest(directory), /committed, unchanged/)
    commit()
    assert.notEqual(trackedSourceDigest(directory).sourceDigest, before.sourceDigest)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('source hashing reads the checked descriptor instead of reopening a swappable pathname', t => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'local-source-descriptor-'))
  const root = path.join(directory, 'source')
  fs.mkdirSync(root)
  const filename = path.join(root, 'source.ts')
  const outside = path.join(directory, 'outside.txt')
  const git = (...args) => execFileSync('/usr/bin/git', args, { cwd: root })
  try {
    fs.writeFileSync(filename, 'export const owned = true\n')
    fs.writeFileSync(outside, 'unrelated fixture bytes\n')
    git('init', '--quiet')
    git('add', '.')
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'Fixture'
    )
    const expected = trackedSourceDigest(root)
    const read = fs.readFileSync
    t.mock.method(fs, 'readFileSync', (file, ...args) => {
      if (file === filename) {
        fs.unlinkSync(filename)
        fs.symlinkSync(outside, filename)
      }
      return read(file, ...args)
    })
    assert.deepEqual(trackedSourceDigest(root), expected)
    assert.equal(fs.lstatSync(filename).isSymbolicLink(), false)
  } finally {
    t.mock.restoreAll()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('source closure rejects tracked symlinks and preserves locale-independent Unicode ordering', () => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'local-source-kinds-'))
  const git = (...args) => execFileSync('/usr/bin/git', args, { cwd: directory })
  const commit = () => {
    git('add', '.')
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'Fixture'
    )
  }
  try {
    const names = ['a-lower.txt', 'A-upper.txt', '\ue000.txt', '\u{10000}.txt']
    for (const name of names) fs.writeFileSync(path.join(directory, name), name)
    git('init', '--quiet')
    commit()
    const legacyOrder = ['A-upper.txt', 'a-lower.txt', '\u{10000}.txt', '\ue000.txt']
    assert.equal(
      trackedSourceDigest(directory).sourceDigest,
      digest(JSON.stringify(legacyOrder.map(name => [name, digest(name)])))
    )
    fs.symlinkSync('a-lower.txt', path.join(directory, 'link.txt'))
    commit()
    assert.throws(
      () => trackedSourceDigest(directory),
      error => error.code === 'ELOOP'
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
