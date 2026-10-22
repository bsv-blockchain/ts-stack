#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const root = fileURLToPath(new URL('..', import.meta.url))
const gitExecutable =
  process.platform === 'win32' ? String.raw`C:\Program Files\Git\cmd\git.exe` : '/usr/bin/git'
export const walletJournalSuites = Object.freeze([
  Object.freeze({
    file: 'packages/wallet/wallet-toolbox/src/storage/__test/WalletStorageManager.journal.test.ts',
    names: Object.freeze([
      'ordinary push uses durable journal succession and preserves tombstones across fresh manager instances',
      'a foreground write during capture is reconciled before primary activation, without queue ownership across the read',
      'partial journal installation fails before the ordinary legacy transport can run',
      'serialized resource fallback reports the actual acknowledged journal prefix and every legacy commit',
      'a typed resource progress-observer error rejects exactly without selecting legacy fallback',
      'a typed cancelled progress-observer error rejects exactly without selecting legacy fallback',
      'a cancellation observer cannot mutate the returned journal custody position',
      'a committed activation with a lost reply recovers through a replacement manager without reactivating its source',
      'cancellation during a genuine warm copy drains and allows the same durable plan to resume',
      'primary handoff continues through genuine large operational history and retains its exact field provenance'
    ])
  })
])
const caseCount = 10
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const ordered = values =>
  [...values].sort((left, right) => Number(left > right) - Number(left < right))

export function validateWalletJournalReport(report) {
  if (
    report?.success !== true ||
    report.numTotalTestSuites !== 1 ||
    report.numPassedTestSuites !== 1 ||
    report.numFailedTestSuites !== 0 ||
    report.numPendingTestSuites !== 0 ||
    report.numRuntimeErrorTestSuites !== 0 ||
    report.numTotalTests !== caseCount ||
    report.numPassedTests !== caseCount ||
    report.numFailedTests !== 0 ||
    report.numPendingTests !== 0 ||
    report.numTodoTests !== 0 ||
    !Array.isArray(report.testResults) ||
    report.testResults.length !== 1
  )
    throw new Error('Journal report requires the original suite and all ten passing cases')
  const seen = new Set()
  for (const suite of report.testResults) {
    const expected = walletJournalSuites.find(
      value =>
        typeof suite?.name === 'string' &&
        suite.name.replaceAll('\\', '/').endsWith('/' + value.file)
    )
    if (
      expected === undefined ||
      seen.has(expected.file) ||
      suite.status !== 'passed' ||
      suite.message !== '' ||
      !Array.isArray(suite.assertionResults) ||
      !isDeepStrictEqual(
        ordered(suite.assertionResults.map(value => value.fullName)),
        ordered(expected.names)
      ) ||
      suite.assertionResults.some(
        value =>
          value.status !== 'passed' ||
          !Array.isArray(value.failureMessages) ||
          value.failureMessages.length !== 0
      )
    )
      throw new Error(
        'Journal suite failed, repeated, skipped or changed its original case inventory'
      )
    seen.add(expected.file)
  }
  return caseCount
}

export function validateWalletJournalEvidence(receipt, identity, reportBytes, lcovBytes) {
  if (
    !isDeepStrictEqual(receipt?.identity, identity) ||
    receipt?.passedCases !== caseCount ||
    receipt?.reportSha256 !== digest(reportBytes) ||
    receipt?.lcovSha256 !== digest(lcovBytes) ||
    lcovBytes.length === 0 ||
    !lcovBytes.toString('utf8').includes('end_of_record')
  )
    throw new Error('Journal evidence is stale, incomplete or changed')
  return validateWalletJournalReport(JSON.parse(reportBytes.toString('utf8')))
}

function executionIdentity() {
  const head = execFileSync(gitExecutable, ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8'
  }).trim()
  const files = [
    ...walletJournalSuites.map(value => value.file),
    'scripts/wallet-journal-ci.mjs',
    '.github/workflows/ci.yml'
  ]
  if (
    !/^[1-9]\d*$/.test(process.env.GITHUB_RUN_ID ?? '') ||
    !/^[1-9]\d*$/.test(process.env.GITHUB_RUN_ATTEMPT ?? '') ||
    process.env.GITHUB_SHA !== head ||
    execFileSync(gitExecutable, ['status', '--porcelain', '--untracked-files=no'], {
      cwd: root,
      encoding: 'utf8'
    }).trim() !== ''
  )
    throw new Error('Journal receipt requires the clean exact GitHub Actions revision and run')
  execFileSync(gitExecutable, ['ls-files', '--error-unmatch', '--', ...files], {
    cwd: root,
    stdio: 'pipe'
  })
  return {
    head,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    sources: Object.fromEntries(
      files.map(file => [file, digest(fs.readFileSync(path.join(root, file)))])
    )
  }
}

function receiptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) return receiptFiles(filename)
    return entry.isFile() && entry.name.endsWith('.wallet-journal.json') ? [filename] : []
  })
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const [command, ...args] = process.argv.slice(2)
    if (command === 'capture' && args.length === 3) {
      const bytes = fs.readFileSync(args[0]),
        lcov = fs.readFileSync(args[1])
      if (
        path.basename(args[1]) !== 'wallet-journal.lcov.info' ||
        path.dirname(path.resolve(args[1])) !== path.dirname(path.resolve(args[2]))
      )
        throw new Error('Journal LCOV must accompany its receipt under the fixed artifact name')
      const receipt = {
        identity: executionIdentity(),
        passedCases: validateWalletJournalReport(JSON.parse(bytes)),
        reportSha256: digest(bytes),
        lcovSha256: digest(lcov)
      }
      validateWalletJournalEvidence(receipt, receipt.identity, bytes, lcov)
      fs.writeFileSync(args[2] + '.jest.json', bytes, { flag: 'wx' })
      fs.writeFileSync(args[2], JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' })
    } else if (command === 'verify' && args.length === 1) {
      const receipts = receiptFiles(args[0])
      if (receipts.length !== 1) throw new Error('Expected exactly one mandatory journal receipt')
      const filename = receipts[0]
      validateWalletJournalEvidence(
        JSON.parse(fs.readFileSync(filename, 'utf8')),
        executionIdentity(),
        fs.readFileSync(filename + '.jest.json'),
        fs.readFileSync(path.join(path.dirname(filename), 'wallet-journal.lcov.info'))
      )
      console.log('All10 original journal cases passed with exact-source report and LCOV evidence')
    } else throw new Error('Expected capture <report> <lcov> <receipt>, or verify <directory>')
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause))
    process.exitCode = 1
  }
}
