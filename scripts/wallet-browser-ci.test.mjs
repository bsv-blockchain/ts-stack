import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { readFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import {
  walletBrowserSuites,
  validateWalletBrowserReport,
  validateWalletBrowserEvidence
} from './wallet-browser-ci.mjs'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
function report() {
  return {
    success: true,
    numTotalTestSuites: 3,
    numPassedTestSuites: 3,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    numRuntimeErrorTestSuites: 0,
    numTotalTests: 64,
    numPassedTests: 64,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: walletBrowserSuites.map(value => ({
      name: '/repo/' + value.file,
      status: 'passed',
      message: '',
      assertionResults: value.names.map(fullName => ({
        fullName,
        status: 'passed',
        failureMessages: []
      }))
    }))
  }
}

test('the serial browser plan retains every original declaration, name and multiplicity', () => {
  const source = readFileSync(new URL('../' + walletBrowserSuites[0].file, import.meta.url), 'utf8')
  const ids = [...source.matchAll(/\[\s*'([^']+)'\s*,\s*'[^']+'/g)].map(value => value[1])
  assert.equal(ids.length, 61)
  assert.deepEqual(
    ids.map(id => `native browser component: ${id}`),
    walletBrowserSuites[0].names
  )
  for (const suite of walletBrowserSuites.slice(1)) {
    const actual = readFileSync(new URL('../' + suite.file, import.meta.url), 'utf8')
    assert.deepEqual(
      [...actual.matchAll(/\btest\(\s*'([^']+)'/g)].map(value => value[1]),
      suite.names
    )
  }
  assert.equal(
    walletBrowserSuites.reduce((total, suite) => total + suite.names.length, 0),
    64
  )
  assert.equal(validateWalletBrowserReport(report()), 64)
})

test('browser execution refuses missing, repeated, renamed, skipped and failed original cases', () => {
  for (const alter of [
    value => {
      value.success = false
    },
    value => {
      value.numRuntimeErrorTestSuites = 1
    },
    value => {
      value.numPendingTests = 1
    },
    value => {
      value.numTodoTests = 1
    },
    value => {
      value.numPassedTests--
    },
    value => {
      value.testResults.pop()
    },
    value => {
      value.testResults[1] = structuredClone(value.testResults[0])
    },
    value => {
      value.testResults[0].status = 'failed'
    },
    value => {
      value.testResults[0].message = 'late browser failure'
    },
    value => {
      value.testResults[0].assertionResults.pop()
    },
    value => {
      value.testResults[0].assertionResults[0].fullName += ' renamed'
    },
    value => {
      value.testResults[0].assertionResults[0].status = 'pending'
    },
    value => {
      value.testResults[0].assertionResults[0].status = 'failed'
    },
    value => {
      value.testResults[0].assertionResults[0].failureMessages = ['failed']
    },
    value => {
      value.testResults[0].assertionResults[1] = structuredClone(
        value.testResults[0].assertionResults[0]
      )
    }
  ]) {
    const value = report()
    alter(value)
    assert.throws(() => validateWalletBrowserReport(value))
  }
})

test('browser report and LCOV evidence must match the exact revision, run, source and bytes', () => {
  const identity = {
    head: 'a'.repeat(40),
    runId: '123',
    runAttempt: '1',
    sources: { test: 'b'.repeat(64) }
  }
  const bytes = Buffer.from(JSON.stringify(report())),
    lcov = Buffer.from('TN:\nSF:example.ts\nend_of_record\n')
  const receipt = {
    identity,
    passedCases: 64,
    reportSha256: digest(bytes),
    lcovSha256: digest(lcov)
  }
  assert.equal(validateWalletBrowserEvidence(receipt, identity, bytes, lcov), 64)
  for (const changed of [
    { ...identity, head: 'c'.repeat(40) },
    { ...identity, runId: '124' },
    { ...identity, runAttempt: '2' },
    { ...identity, sources: { test: 'd'.repeat(64) } }
  ])
    assert.throws(() => validateWalletBrowserEvidence(receipt, changed, bytes, lcov))
  for (const changed of [
    { ...receipt, passedCases: 63 },
    { ...receipt, reportSha256: 'e'.repeat(64) },
    { ...receipt, lcovSha256: 'f'.repeat(64) }
  ])
    assert.throws(() => validateWalletBrowserEvidence(changed, identity, bytes, lcov))
  assert.throws(() => validateWalletBrowserEvidence(receipt, identity, Buffer.from('{}'), lcov))
  assert.throws(() => validateWalletBrowserEvidence(receipt, identity, bytes, Buffer.from('')))
  const failed = report()
  failed.testResults[0].assertionResults[0].status = 'failed'
  const failedBytes = Buffer.from(JSON.stringify(failed))
  assert.throws(() =>
    validateWalletBrowserEvidence(
      { ...receipt, reportSha256: digest(failedBytes) },
      identity,
      failedBytes,
      lcov
    )
  )
})

test('actual browser receipt CLI rejects missing, duplicate, stale, dirty and tampered evidence', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wallet-browser-receipt-unit-'))
  const run = (command, args, environment = {}) =>
    spawnSync(command, args, {
      cwd: directory,
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, ...environment }
    })
  const git = args => {
    const result = run('git', [
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=Browser receipt unit test',
      '-c',
      'user.email=browser-receipt@example.invalid',
      '-c',
      'core.hooksPath=' + join(directory, 'empty-hooks'),
      ...args
    ])
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  try {
    mkdirSync(join(directory, 'scripts'))
    mkdirSync(join(directory, '.github/workflows'), { recursive: true })
    mkdirSync(join(directory, 'empty-hooks'))
    copyFileSync(
      new URL('./wallet-browser-ci.mjs', import.meta.url),
      join(directory, 'scripts/wallet-browser-ci.mjs')
    )
    for (const suite of walletBrowserSuites) {
      mkdirSync(dirname(join(directory, suite.file)), { recursive: true })
      writeFileSync(
        join(directory, suite.file),
        'Explicit unit source fixture; never executed as browser qualification.\n'
      )
    }
    writeFileSync(join(directory, '.github/workflows/ci.yml'), 'name: unit fixture\n')
    writeFileSync(join(directory, '.gitignore'), '/evidence/\n/input.json\n')
    git(['init', '--quiet', '--initial-branch=main'])
    git(['add', '.'])
    git(['commit', '--quiet', '-m', 'Unit fixture only'])
    const head = git(['rev-parse', 'HEAD'])
    const environment = { GITHUB_SHA: head, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' }
    const cli = (args, overrides = {}) =>
      run(process.execPath, ['scripts/wallet-browser-ci.mjs', ...args], {
        ...environment,
        ...overrides
      })
    mkdirSync(join(directory, 'evidence'))
    writeFileSync(join(directory, 'input.json'), JSON.stringify(report()))
    const lcov = 'TN:\nSF:unit-fixture.ts\nend_of_record\n'
    writeFileSync(join(directory, 'evidence/wallet-browser.lcov.info'), lcov)
    const packet = 'evidence/unit.wallet-browser.json'
    const capture = ['capture', 'input.json', 'evidence/wallet-browser.lcov.info', packet]
    assert.notEqual(cli(['verify', 'evidence']).status, 0)
    assert.notEqual(cli(capture, { GITHUB_RUN_ID: '' }).status, 0)
    const captured = cli(capture)
    assert.equal(captured.status, 0, captured.stderr)
    assert.equal(cli(['verify', 'evidence']).status, 0)
    assert.notEqual(cli(capture).status, 0)
    for (const changed of [
      { GITHUB_RUN_ID: '124' },
      { GITHUB_RUN_ATTEMPT: '2' },
      { GITHUB_SHA: 'f'.repeat(40) }
    ])
      assert.notEqual(cli(['verify', 'evidence'], changed).status, 0)
    copyFileSync(join(directory, packet), join(directory, 'evidence/duplicate.wallet-browser.json'))
    assert.notEqual(cli(['verify', 'evidence']).status, 0)
    rmSync(join(directory, 'evidence/duplicate.wallet-browser.json'))
    const bytes = readFileSync(join(directory, packet + '.jest.json'))
    writeFileSync(join(directory, packet + '.jest.json'), '{}')
    assert.notEqual(cli(['verify', 'evidence']).status, 0)
    writeFileSync(join(directory, packet + '.jest.json'), bytes)
    writeFileSync(join(directory, 'evidence/wallet-browser.lcov.info'), lcov + 'tampered')
    assert.notEqual(cli(['verify', 'evidence']).status, 0)
    writeFileSync(join(directory, 'evidence/wallet-browser.lcov.info'), lcov)
    assert.equal(cli(['verify', 'evidence']).status, 0)
    writeFileSync(join(directory, walletBrowserSuites[0].file), 'dirty source\n')
    assert.notEqual(cli(['verify', 'evidence']).status, 0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
