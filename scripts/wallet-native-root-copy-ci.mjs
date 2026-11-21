import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const rootCopyTestFile =
  'packages/wallet/wallet-toolbox/src/storage/portable/native/RootNativeCopyContracts.test.cjs'
export const rootCopyCaseNames = Object.freeze([
  'actual Linux root file-copy fixture preserves exact bytes, closes descriptors and conveys no Darwin ACL grant',
  ...['symlink', 'writable', 'hard-link', 'truncated', 'corrupted'].map(
    kind => `actual root-copy ${kind} source refuses; only a newly created failed file may remain`
  ),
  'a replaced root-copy parent refuses before creating a file in either directory',
  'root-copy failed close retains the actual descriptor and blocks another copy until idempotent retry'
])
function compareNames(first, second) {
  if (first < second) return -1
  if (first > second) return 1
  return 0
}
export function validateRootCopyReport(report, repositoryRoot = root) {
  assert.equal(report.success, true)
  assert.equal(report.numTotalTestSuites, 1)
  assert.equal(report.numPassedTestSuites, 1)
  assert.equal(report.numFailedTestSuites, 0)
  assert.equal(report.numPendingTestSuites, 0)
  assert.equal(report.numTotalTests, rootCopyCaseNames.length)
  assert.equal(report.numPassedTests, rootCopyCaseNames.length)
  assert.equal(report.numFailedTests, 0)
  assert.equal(report.numPendingTests, 0)
  assert.equal(report.numTodoTests, 0)
  assert.equal(report.testResults.length, 1)
  const suite = report.testResults[0]
  assert.equal(suite.name, resolve(repositoryRoot, rootCopyTestFile))
  assert.equal(suite.status, 'passed')
  assert.equal(suite.assertionResults.length, rootCopyCaseNames.length)
  assert.ok(suite.assertionResults.every(value => value.status === 'passed'))
  assert.deepEqual(
    suite.assertionResults.map(value => value.fullName).sort(compareNames),
    [...rootCopyCaseNames].sort(compareNames)
  )
  return { originalCases: rootCopyCaseNames.length, passed: rootCopyCaseNames.length }
}
/** Consume a bounded CI report without accepting a filesystem path from the CLI. */
export function readRootCopyReport(input) {
  return new Promise((resolveReport, rejectReport) => {
    let buffer = Buffer.alloc(67108864),
      bytes = 0,
      settled = false
    const clean = () => {
      input.off('data', data)
      input.off('end', end)
      input.off('error', fail)
      input.off('close', close)
      buffer = undefined
    }
    const fail = error => {
      if (settled) return
      settled = true
      clean()
      input.destroy()
      rejectReport(error)
    }
    const data = chunk => {
      if (!Buffer.isBuffer(chunk)) {
        fail(new TypeError('Root-copy report requires byte input'))
        return
      }
      if (chunk.length > 67108864 - bytes) {
        fail(new RangeError('Root-copy report exceeds its 64 MiB byte ceiling'))
        return
      }
      chunk.copy(buffer, bytes)
      bytes += chunk.length
    }
    const end = () => {
      if (settled) return
      try {
        const report = JSON.parse(buffer.toString('utf8', 0, bytes))
        settled = true
        clean()
        resolveReport(report)
      } catch (error) {
        fail(error)
      }
    }
    const close = () => fail(new Error('Root-copy report input closed before completion'))
    input.on('data', data)
    input.once('end', end)
    input.once('error', fail)
    input.once('close', close)
  })
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 2)
  console.log(JSON.stringify(validateRootCopyReport(await readRootCopyReport(process.stdin))))
}
