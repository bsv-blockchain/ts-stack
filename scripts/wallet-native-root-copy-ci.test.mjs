import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { Readable, PassThrough } from 'node:stream'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  readRootCopyReport,
  rootCopyCaseNames,
  rootCopyTestFile,
  validateRootCopyReport
} from './wallet-native-root-copy-ci.mjs'

function complete() {
  return {
    success: true,
    numTotalTestSuites: 1,
    numPassedTestSuites: 1,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    numTotalTests: 8,
    numPassedTests: 8,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: [
      {
        name: resolve(rootCopyTestFile),
        status: 'passed',
        assertionResults: rootCopyCaseNames.map(fullName => ({ fullName, status: 'passed' }))
      }
    ]
  }
}
test('all eight original root-copy cases are mandatory even when aggregate success is asserted', () => {
  assert.deepEqual(validateRootCopyReport(complete(), process.cwd()), {
    originalCases: 8,
    passed: 8
  })
  for (const defect of [
    'missing',
    'duplicate',
    'pending',
    'failed',
    'foreign-file',
    'wrong-count',
    'todo'
  ]) {
    const report = complete(),
      suite = report.testResults[0]
    if (defect === 'missing') suite.assertionResults.pop()
    if (defect === 'duplicate')
      suite.assertionResults[1].fullName = suite.assertionResults[0].fullName
    if (defect === 'pending') suite.assertionResults[0].status = 'pending'
    if (defect === 'failed') suite.assertionResults[0].status = 'failed'
    if (defect === 'foreign-file') suite.name += '.foreign'
    if (defect === 'wrong-count') report.numPassedTests = 7
    if (defect === 'todo') report.numTodoTests = 1
    assert.throws(() => validateRootCopyReport(report, process.cwd()), undefined, defect)
  }
})

test('stdin report preserves all eight original case oracles', async () => {
  const report = await readRootCopyReport(Readable.from([Buffer.from(JSON.stringify(complete()))]))
  assert.deepEqual(validateRootCopyReport(report, process.cwd()), { originalCases: 8, passed: 8 })
})
test('report input rejects invalid JSON, interrupted streams and over-limit bytes', async () => {
  await assert.rejects(readRootCopyReport(Readable.from([Buffer.from('{')])), SyntaxError)
  await assert.rejects(readRootCopyReport(Readable.from(['text-mode'])), /requires byte input/)
  const interrupted = new PassThrough()
  const failed = readRootCopyReport(interrupted)
  const interruptedCheck = assert.rejects(failed, /closed before completion/)
  interrupted.destroy()
  await interruptedCheck
  const oversized = new PassThrough()
  const refused = assert.rejects(readRootCopyReport(oversized), /64 MiB byte ceiling/)
  const block = Buffer.alloc(1048576, 32)
  for (let i = 0; i < 64; i++) oversized.write(block)
  oversized.write(Buffer.from('x'))
  await refused
  assert.equal(oversized.destroyed, true)
})

test('CLI refuses filesystem path arguments before reading a report', () => {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('./wallet-native-root-copy-ci.mjs', import.meta.url)),
      '../../outside-report.json'
    ],
    { encoding: 'utf8', timeout: 10000, maxBuffer: 65536 }
  )
  assert.equal(result.error, undefined)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /AssertionError/)
  assert.equal(result.stdout, '')
})
