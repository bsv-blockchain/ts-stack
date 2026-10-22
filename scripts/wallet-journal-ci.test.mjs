import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { readFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { parse } from 'yaml'
import { buildMutationTargets } from '../governance/mutation-testing/targets.mjs'
import { selectAffectedMutationTargets, REPOSITORY_ROOT } from './mutation-testing.mjs'
import {
  walletJournalSuites,
  validateWalletJournalReport,
  validateWalletJournalEvidence
} from './wallet-journal-ci.mjs'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')

test('journal scheduling requires the complete serial file, exact exclusion and aggregate admission', () => {
  const workflow = parse(
    readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  )
  const wallet = workflow.jobs['coverage-wallet']
  const serial = wallet.steps.filter(
    step => step.name === 'Run every original journal case serially before ordinary shard-2'
  )
  assert.equal(serial.length, 1)
  assert.equal(serial[0].if, "matrix.id == 'shard-2'")
  assert.equal(serial[0]['continue-on-error'], undefined)
  assert.match(serial[0].run, /--runInBand --watchman=false/)
  assert.match(
    serial[0].run,
    /--runTestsByPath src\/storage\/__test\/WalletStorageManager\.journal\.test\.ts/
  )
  assert.doesNotMatch(serial[0].run, /--testNamePattern|--testTimeout/)
  assert.match(serial[0].run, /wallet-journal-ci\.mjs capture/)
  const ordinary = wallet.steps.find(step => step.name === 'Generate wallet-toolbox coverage shard')
  assert.ok(wallet.steps.indexOf(serial[0]) < wallet.steps.indexOf(ordinary))
  const ignored = /--testPathIgnorePatterns='([^']+)'/.exec(ordinary.run)[1]
  const pattern = ignored.split('|').find(value => value.includes('WalletStorageManager'))
  const exclude = new RegExp(pattern)
  assert.ok(exclude.test('/repo/src/storage/__test/WalletStorageManager.journal.test.ts'))
  assert.ok(!exclude.test('/repo/src/storage/__test/WalletStorageManager.journal.test.ts.extra'))
  assert.ok(!exclude.test('/repo/src/storage/__test/WalletStorageManagerXjournalXtestXts'))
  const coverage = workflow.jobs['coverage-upload'].steps
  const verify = coverage.filter(
    step => step.run === 'node scripts/wallet-journal-ci.mjs verify .coverage-artifacts'
  )
  assert.equal(verify.length, 1)
  assert.equal(verify[0].if, "needs.prepare.outputs.wallet == 'true'")
  assert.equal(verify[0]['continue-on-error'], undefined)
  assert.ok(
    coverage.indexOf(verify[0]) < coverage.findIndex(step => step.name === 'Compose Codecov inputs')
  )
})

test('journal functional routing retains all affected owners and every registered property', () => {
  const targets = buildMutationTargets(REPOSITORY_ROOT)
  const file = walletJournalSuites[0].file
  const relative = file.slice('packages/wallet/wallet-toolbox/'.length)
  const affected = selectAffectedMutationTargets(targets, [file])
  const routed = Object.entries(targets).filter(([, target]) =>
    target.requiredFunctionalTests?.includes(relative)
  )
  assert.ok(routed.length >= 8)
  for (const [id, target] of routed) {
    assert.ok(affected.includes(id))
    for (const input of ['scripts/wallet-journal-ci.mjs', '.github/workflows/ci.yml'])
      assert.ok(selectAffectedMutationTargets(targets, [input]).includes(id))
    const config = target.runnerOptions.jest.config
    assert.ok(!config.testMatch.includes('<rootDir>/' + relative))
    assert.ok(
      config.testPathIgnorePatterns.some(pattern =>
        new RegExp(pattern.replace('<rootDir>', '/repo')).test('/repo/' + relative)
      )
    )
    assert.ok(
      config.testMatch.includes(
        '<rootDir>/' + target.propertyTest.slice(target.packageDirectory.length + 1)
      )
    )
  }
})

function report() {
  return {
    success: true,
    numTotalTestSuites: 1,
    numPassedTestSuites: 1,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    numRuntimeErrorTestSuites: 0,
    numTotalTests: 10,
    numPassedTests: 10,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: walletJournalSuites.map(value => ({
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

test('the serial journal plan retains all ten original declarations and names', () => {
  const source = readFileSync(new URL('../' + walletJournalSuites[0].file, import.meta.url), 'utf8')
  const names = [...source.matchAll(/\btest\(\s*'([^']+)'/g)].map(value => value[1])
  assert.match(source, /test\.each\(\['resource', 'cancelled'\] as const\)/)
  const parameterized = /'([^']*%s[^']*)'/.exec(source)[1]
  names.splice(4, 0, ...['resource', 'cancelled'].map(value => parameterized.replace('%s', value)))
  assert.deepEqual(names, walletJournalSuites[0].names)
  assert.equal(validateWalletJournalReport(report()), 10)
})

test('journal execution refuses missing, repeated, renamed, skipped and failed original cases', () => {
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
      value.testResults.push(structuredClone(value.testResults[0]))
    },
    value => {
      value.testResults[0].status = 'failed'
    },
    value => {
      value.testResults[0].message = 'late journal failure'
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
    assert.throws(() => validateWalletJournalReport(value))
  }
})

test('journal report and LCOV evidence must match the exact revision, run, source and bytes', () => {
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
    passedCases: 10,
    reportSha256: digest(bytes),
    lcovSha256: digest(lcov)
  }
  assert.equal(validateWalletJournalEvidence(receipt, identity, bytes, lcov), 10)
  for (const changed of [
    { ...identity, head: 'c'.repeat(40) },
    { ...identity, runId: '124' },
    { ...identity, runAttempt: '2' },
    { ...identity, sources: { test: 'd'.repeat(64) } }
  ])
    assert.throws(() => validateWalletJournalEvidence(receipt, changed, bytes, lcov))
  for (const changed of [
    { ...receipt, passedCases: 9 },
    { ...receipt, reportSha256: 'e'.repeat(64) },
    { ...receipt, lcovSha256: 'f'.repeat(64) }
  ])
    assert.throws(() => validateWalletJournalEvidence(changed, identity, bytes, lcov))
  assert.throws(() => validateWalletJournalEvidence(receipt, identity, Buffer.from('{}'), lcov))
  assert.throws(() => validateWalletJournalEvidence(receipt, identity, bytes, Buffer.from('')))
  const failed = report()
  failed.testResults[0].assertionResults[0].status = 'failed'
  const failedBytes = Buffer.from(JSON.stringify(failed))
  assert.throws(() =>
    validateWalletJournalEvidence(
      { ...receipt, reportSha256: digest(failedBytes) },
      identity,
      failedBytes,
      lcov
    )
  )
})

test('actual journal receipt CLI rejects missing, duplicate, stale, dirty and tampered evidence', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wallet-journal-receipt-unit-'))
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
      'user.name=Journal receipt unit test',
      '-c',
      'user.email=journal-receipt@example.invalid',
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
      new URL('./wallet-journal-ci.mjs', import.meta.url),
      join(directory, 'scripts/wallet-journal-ci.mjs')
    )
    for (const suite of walletJournalSuites) {
      mkdirSync(dirname(join(directory, suite.file)), { recursive: true })
      writeFileSync(
        join(directory, suite.file),
        'Explicit unit source fixture; never executed as journal qualification.\n'
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
      run(process.execPath, ['scripts/wallet-journal-ci.mjs', ...args], {
        ...environment,
        ...overrides
      })
    mkdirSync(join(directory, 'evidence'))
    writeFileSync(join(directory, 'input.json'), JSON.stringify(report()))
    const lcov = 'TN:\nSF:unit-fixture.ts\nend_of_record\n'
    writeFileSync(join(directory, 'evidence/wallet-journal.lcov.info'), lcov)
    const packet = 'evidence/unit.wallet-journal.json'
    const capture = ['capture', 'input.json', 'evidence/wallet-journal.lcov.info', packet]
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
    copyFileSync(join(directory, packet), join(directory, 'evidence/duplicate.wallet-journal.json'))
    assert.notEqual(cli(['verify', 'evidence']).status, 0)
    rmSync(join(directory, 'evidence/duplicate.wallet-journal.json'))
    const bytes = readFileSync(join(directory, packet + '.jest.json'))
    writeFileSync(join(directory, packet + '.jest.json'), '{}')
    assert.notEqual(cli(['verify', 'evidence']).status, 0)
    writeFileSync(join(directory, packet + '.jest.json'), bytes)
    writeFileSync(join(directory, 'evidence/wallet-journal.lcov.info'), lcov + 'tampered')
    assert.notEqual(cli(['verify', 'evidence']).status, 0)
    writeFileSync(join(directory, 'evidence/wallet-journal.lcov.info'), lcov)
    assert.equal(cli(['verify', 'evidence']).status, 0)
    writeFileSync(join(directory, walletJournalSuites[0].file), 'dirty source\n')
    assert.notEqual(cli(['verify', 'evidence']).status, 0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
