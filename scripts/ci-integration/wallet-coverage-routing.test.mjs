import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPOSITORY_ROOT } from '../repository-health.mjs'
import { createHash } from 'node:crypto'
import { walletCoverageMatrix } from '../wallet-composed-native-ci.mjs'
import { walletBrowserSuites } from '../wallet-browser-ci.mjs'
import { buildMutationTargets } from '../../governance/mutation-testing/targets.mjs'
import { selectedMutationPartition } from '../mutation-partitions.mjs'

test('actual scope Bash routes every affected wallet to complete coverage exactly once', async () => {
  const { parse } = await import('yaml')
  const workflow = parse(readFileSync(join(REPOSITORY_ROOT, '.github/workflows/ci.yml'), 'utf8'))
  const script = workflow.jobs.prepare.steps.find(step => step.id === 'scope').run
  const wallet = {
    name: '@bsv/wallet-toolbox',
    path: join(REPOSITORY_ROOT, 'packages/wallet/wallet-toolbox')
  }
  const sdk = { name: '@bsv/sdk', path: join(REPOSITORY_ROOT, 'packages/sdk') }
  for (const { direct, affected, selected, dependents } of [
    { direct: [wallet], affected: [wallet], selected: true, dependents: [] },
    { direct: [sdk], affected: [sdk, wallet], selected: true, dependents: [] },
    { direct: [], affected: [wallet, sdk], selected: true, dependents: ['@bsv/sdk'] },
    { direct: [], affected: [sdk], selected: false, dependents: ['@bsv/sdk'] },
    { direct: [], affected: [], selected: false, dependents: [] }
  ]) {
    const directory = mkdtempSync(join(tmpdir(), 'wallet-ci-scope-'))
    try {
      mkdirSync(join(directory, 'scripts'))
      copyFileSync(
        join(REPOSITORY_ROOT, 'scripts/run-ci-tests.mjs'),
        join(directory, 'scripts/run-ci-tests.mjs')
      )
      const output = join(directory, 'output')
      const summary = join(directory, 'summary')
      const result = spawnSync('/bin/bash', ['-e', '-c', script], {
        cwd: directory,
        encoding: 'utf8',
        timeout: 10000,
        env: {
          ...process.env,
          DIRECT_PROJECTS: JSON.stringify(direct),
          AFFECTED_PROJECTS: JSON.stringify(affected),
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary
        }
      })
      assert.equal(result.status, 0, result.stderr)
      const values = Object.fromEntries(
        readFileSync(output, 'utf8')
          .trim()
          .split('\n')
          .map(line => {
            const index = line.indexOf('=')
            return [line.slice(0, index), line.slice(index + 1)]
          })
      )
      assert.equal(values.wallet, String(selected))
      assert.deepEqual(JSON.parse(values['dependent-test-packages']), dependents)
      if (selected) assert.equal(values['coverage-required'], 'true')
      assert.equal(values.sdk, String(direct.some(project => project.name === sdk.name)))
      assert.ok(
        workflow.jobs['coverage-wallet'].if.includes("needs.prepare.outputs.wallet == 'true'")
      )
      assert.ok(
        workflow.jobs['coverage-upload'].if.includes(
          "needs.prepare.outputs['coverage-required'] == 'true'"
        ) ||
          workflow.jobs['coverage-upload'].if.includes(
            "needs.prepare.outputs.coverage-required == 'true'"
          )
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
})

test('ordinary wallet discovery removes only the two complete mandatory native files under unchanged limits', async () => {
  const { parse } = await import('yaml')
  const workflow = parse(readFileSync(join(REPOSITORY_ROOT, '.github/workflows/ci.yml'), 'utf8'))
  const job = workflow.jobs['coverage-wallet']
  assert.equal(
    job['timeout-minutes'],
    "${{ matrix.native_cohort == 'completed' && 265 || matrix.native_cohort != '' && 145 || matrix.native_merge_minutes || matrix.native_auth_minutes || 40 }}"
  )
  const step = job.steps.find(
    value =>
      value.run?.includes('NATIVE_AUTH_COHORT') &&
      value.run?.includes('pnpm --filter @bsv/wallet-toolbox exec jest')
  )
  const source = step.run
  const pattern = /args\+=\(--testPathIgnorePatterns='([^']+)'\)/.exec(source)[1]
  const files = [
    'src/storage/snapshot/NativeSnapshotReadContractsNode.test.ts',
    'src/storage/portable/Brc38NativeUserInventoryContractsNode.test.ts'
  ]
  const originalPattern = pattern
    .split('|')
    .filter(value => !files.includes(value))
    .join('|')
  const discover = ignored => {
    const result = spawnSync(
      process.execPath,
      [
        join(REPOSITORY_ROOT, 'packages/wallet/wallet-toolbox/node_modules/jest/bin/jest.js'),
        '--listTests',
        '--json',
        '--runInBand',
        '--watchman=false',
        '--testPathIgnorePatterns=' + ignored
      ],
      {
        cwd: join(REPOSITORY_ROOT, 'packages/wallet/wallet-toolbox'),
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 4194304
      }
    )
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout)
      .map(file => file.replaceAll('\\', '/'))
      .sort()
  }
  const before = discover(originalPattern),
    after = discover(pattern)
  assert.equal(before.length - after.length, 2)
  assert.deepEqual(
    before
      .filter(file => !after.includes(file))
      .map(file => file.slice(file.indexOf('/src/') + 1))
      .sort(),
    files.sort()
  )
  assert.deepEqual(
    after.filter(file => !before.includes(file)),
    []
  )
  for (const family of ['READ', 'USER']) {
    const lower = family.toLowerCase()
    assert.equal(step.env[`NATIVE_${family}_COHORT`], '${{ matrix.native_' + lower + '_cohort }}')
    assert.ok(
      source.includes(
        `--testNamePattern="$(node scripts/wallet-composed-native-ci.mjs ${lower}-pattern "$NATIVE_${family}_COHORT")"`
      )
    )
    assert.ok(source.includes(`${lower}-capture "$NATIVE_${family}_COHORT"`))
    assert.ok(
      workflow.jobs['coverage-upload'].steps.some(
        value =>
          value.run ===
            `node scripts/wallet-composed-native-ci.mjs ${lower}-verify .coverage-artifacts` &&
          value.if.includes("wallet == 'true'")
      )
    )
  }
})

test('the complete browser inventory runs serially inside original shard-4 with no job or budget increase', async () => {
  const { parse } = await import('yaml')
  const workflow = parse(readFileSync(join(REPOSITORY_ROOT, '.github/workflows/ci.yml'), 'utf8'))
  const job = workflow.jobs['coverage-wallet']
  assert.equal(
    job['timeout-minutes'],
    "${{ matrix.native_cohort == 'completed' && 265 || matrix.native_cohort != '' && 145 || matrix.native_merge_minutes || matrix.native_auth_minutes || 40 }}"
  )
  assert.equal(job.strategy['max-parallel'], 3)
  assert.equal(job.env.NODE_OPTIONS, '--max-old-space-size=1536')
  assert.notEqual(job['continue-on-error'], true)
  const hash = value => createHash('sha256').update(value).digest('hex')
  assert.equal(
    hash(JSON.stringify(walletCoverageMatrix().include.slice(0, 67))),
    'dd62fabe497f3c76ffb5a660c477eb11ce2980d8a93ffbf9aa2ff8380392be6a'
  )
  const browser = job.steps.find(step =>
    step.run?.includes('scripts/wallet-browser-ci.mjs capture')
  )
  const ordinary = job.steps.find(step => step.env?.WALLET_SHARD !== undefined)
  assert.equal(browser.if, "matrix.id == 'shard-4'")
  assert.notEqual(browser['continue-on-error'], true)
  assert.equal(browser.env.RUNPOSTGRES, '1')
  assert.ok(job.steps.indexOf(browser) < job.steps.indexOf(ordinary))
  assert.ok(browser.run.includes('--runInBand'))
  assert.ok(browser.run.includes('--coverage --coverageDirectory=coverage/browser'))
  assert.ok(browser.run.includes('--json --outputFile='))
  assert.equal(browser.run.includes('--testNamePattern'), false)
  assert.equal(browser.run.includes('--maxWorkers'), false)
  const files = walletBrowserSuites.map(suite =>
    suite.file.slice('packages/wallet/wallet-toolbox/'.length)
  )
  const selected = browser.run
    .split('--runTestsByPath ')[1]
    .split('--json')[0]
    .replaceAll('\\', '')
    .trim()
    .split(/\s+/)
  assert.deepEqual(selected, files)
  const pattern = /args\+=\(--testPathIgnorePatterns='([^']+)'\)/.exec(ordinary.run)[1]
  assert.deepEqual(
    pattern.split('|').filter(value => files.includes(value)),
    files
  )
  const original = pattern
    .split('|')
    .filter(value => !files.includes(value))
    .join('|')
  const journalPattern = 'src/storage/__test/WalletStorageManager\\.journal\\.test\\.ts$'
  assert.equal(original.split('|').filter(value => value === journalPattern).length, 1)
  const beforeJournalScheduling = original
    .split('|')
    .filter(value => value !== journalPattern)
    .join('|')
  assert.equal(
    hash(
      beforeJournalScheduling
        .split('|')
        .filter(
          value =>
            value !== 'src/storage/portable/Brc38NativeComposedIntegrityContractsNode.test.ts'
        )
        .join('|')
    ),
    'a71ebd28bbfcc834c30e24049159cac87118ca5e63aed225caaabfc1825bf0f8'
  )
  const discover = ignored => {
    const result = spawnSync(
      process.execPath,
      [
        join(REPOSITORY_ROOT, 'packages/wallet/wallet-toolbox/node_modules/jest/bin/jest.js'),
        '--listTests',
        '--json',
        '--runInBand',
        '--watchman=false',
        '--testPathIgnorePatterns=' + ignored
      ],
      {
        cwd: join(REPOSITORY_ROOT, 'packages/wallet/wallet-toolbox'),
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 4194304
      }
    )
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout)
      .map(file => file.replaceAll('\\', '/'))
      .sort()
  }
  const before = discover(original),
    after = discover(pattern)
  assert.equal(before.length - after.length, 3)
  assert.deepEqual(
    before
      .filter(file => !after.includes(file))
      .map(file => file.slice(file.indexOf('/src/') + 1))
      .sort(),
    [...files].sort()
  )
  assert.deepEqual(
    after.filter(file => !before.includes(file)),
    []
  )
  const delivery = job.steps.find(
    step => step.run === 'node scripts/provision-wallet-native-browser.mjs'
  )
  assert.equal(delivery.if, browser.if)
  assert.ok(job.steps.indexOf(delivery) < job.steps.indexOf(browser))
  assert.ok(browser.run.includes('.coverage-output/wallet-browser.lcov.info'))
  const gate = workflow.jobs['coverage-upload'].steps.find(
    step => step.run === 'node scripts/wallet-browser-ci.mjs verify .coverage-artifacts'
  )
  assert.equal(gate.if, "needs.prepare.outputs.wallet == 'true'")
  assert.notEqual(gate['continue-on-error'], true)
  assert.ok(
    workflow.jobs['coverage-upload'].steps.indexOf(gate) <
      workflow.jobs['coverage-upload'].steps.findIndex(
        step => step.name === 'Compose Codecov inputs'
      )
  )
})

test('native integrity routing removes only its original fullfile and requires the complete fresh union', async () => {
  const { parse } = await import('yaml')
  const workflow = parse(readFileSync(join(REPOSITORY_ROOT, '.github/workflows/ci.yml'), 'utf8'))
  const job = workflow.jobs['coverage-wallet']
  assert.equal(
    job['timeout-minutes'],
    "${{ matrix.native_cohort == 'completed' && 265 || matrix.native_cohort != '' && 145 || matrix.native_merge_minutes || matrix.native_auth_minutes || 40 }}"
  )
  assert.equal(job.strategy['max-parallel'], 3)
  assert.equal(job.env.NODE_OPTIONS, '--max-old-space-size=1536')
  const step = job.steps.find(value => value.env?.WALLET_SHARD !== undefined)
  const file = 'src/storage/portable/Brc38NativeComposedIntegrityContractsNode.test.ts'
  const pattern = /args\+=\(--testPathIgnorePatterns='([^']+)'\)/.exec(step.run)[1]
  assert.equal(pattern.split('|').filter(value => value === file).length, 1)
  const discover = ignored => {
    const result = spawnSync(
      process.execPath,
      [
        join(REPOSITORY_ROOT, 'packages/wallet/wallet-toolbox/node_modules/jest/bin/jest.js'),
        '--listTests',
        '--json',
        '--runInBand',
        '--watchman=false',
        '--testPathIgnorePatterns=' + ignored
      ],
      {
        cwd: join(REPOSITORY_ROOT, 'packages/wallet/wallet-toolbox'),
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 4194304
      }
    )
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout)
      .map(file => file.replaceAll('\\', '/'))
      .sort()
  }
  for (const lane of walletCoverageMatrix().include.filter(
    value => value.native_integrity_cohort
  )) {
    const dispatch = step.run
      .split('pnpm --filter @bsv/wallet-toolbox exec jest')[0]
      .replaceAll('${{ matrix.id }}', lane.id)
    const actual = spawnSync(
      '/bin/bash',
      ['-e', '-c', dispatch + '\nprintf "%s\\0" "${args[@]}"'],
      {
        cwd: REPOSITORY_ROOT,
        encoding: 'utf8',
        timeout: 10000,
        env: {
          ...process.env,
          WALLET_SHARD: '',
          SYNC_LATENCY: '',
          NATIVE_COHORT: '',
          NATIVE_PAIR_COHORT: '',
          NATIVE_MERGE_COHORT: '',
          NATIVE_AUTH_COHORT: '',
          NATIVE_READ_COHORT: '',
          NATIVE_USER_COHORT: '',
          NATIVE_INTEGRITY_COHORT: lane.native_integrity_cohort,
          GITHUB_WORKSPACE: REPOSITORY_ROOT
        }
      }
    )
    assert.equal(actual.status, 0, actual.stderr)
    const args = actual.stdout.split('\0').filter(Boolean)
    assert.ok(args.includes('--runInBand'))
    assert.ok(args.includes('--coverage'))
    assert.equal(args[args.indexOf('--runTestsByPath') + 1], file)
    assert.ok(args.some(value => value.startsWith('--testNamePattern=^')))
    assert.ok(args.includes('--json'))
  }
  const after = discover(pattern),
    before = discover(
      pattern
        .split('|')
        .filter(value => value !== file)
        .join('|')
    )
  assert.equal(before.length - after.length, 1)
  assert.deepEqual(
    before
      .filter(value => !after.includes(value))
      .map(value => value.slice(value.indexOf('/src/') + 1)),
    [file]
  )
  assert.deepEqual(
    after.filter(value => !before.includes(value)),
    []
  )
  assert.equal(step.env.NATIVE_INTEGRITY_COHORT, '${{ matrix.native_integrity_cohort }}')
  assert.ok(step.run.includes('integrity-pattern "$NATIVE_INTEGRITY_COHORT"'))
  assert.ok(step.run.includes('integrity-capture "$NATIVE_INTEGRITY_COHORT"'))
  assert.ok(step.run.includes('--runTestsByPath ' + file))
  const gate = workflow.jobs['coverage-upload'].steps.find(
    value =>
      value.run ===
      'node scripts/wallet-composed-native-ci.mjs integrity-verify .coverage-artifacts'
  )
  assert.equal(gate.if, "needs.prepare.outputs.wallet == 'true'")
  assert.notEqual(gate['continue-on-error'], true)
  assert.ok(
    workflow.jobs['coverage-upload'].steps.indexOf(gate) <
      workflow.jobs['coverage-upload'].steps.findIndex(
        value => value.name === 'Compose Codecov inputs'
      )
  )
})

test('all original retained suites remain in actual ordinary or receipt-gated browser CI when bootstrap components are selected', async () => {
  const { parse } = await import('yaml')
  const workflow = parse(readFileSync(join(REPOSITORY_ROOT, '.github/workflows/ci.yml'), 'utf8'))
  const job = workflow.jobs['coverage-wallet']
  const ordinary = job.steps.find(step => step.env?.WALLET_SHARD !== undefined)
  const wallet = join(REPOSITORY_ROOT, 'packages/wallet/wallet-toolbox')
  const canonical = buildMutationTargets(REPOSITORY_ROOT)['wallet-retained-snapshot']
  const selected = selectedMutationPartition(
    'wallet-retained-snapshot',
    canonical,
    'sqlite-bootstrap-001'
  )
  const base = await (
    await import('../../packages/wallet/wallet-toolbox/jest.config.cjs')
  ).default()
  const discover = args => {
    const result = spawnSync(
      process.execPath,
      [
        join(wallet, 'node_modules/jest/bin/jest.js'),
        ...args,
        '--listTests',
        '--json',
        '--watchman=false'
      ],
      { cwd: wallet, encoding: 'utf8', timeout: 15000, maxBuffer: 4194304 }
    )
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout).map(file => file.replaceAll('\\', '/'))
  }
  const config = target => [
    '--runInBand',
    '--config',
    JSON.stringify({ ...base, ...target.runnerOptions.jest.config, rootDir: wallet })
  ]
  const original = discover(config(canonical))
  const components = discover(config(selected))
  assert.equal(original.length, 81)
  assert.equal(components.length, 9)
  assert.ok(components.every(file => original.includes(file)))
  const ordinaryFiles = []
  const dispatch = ordinary.run
    .split('pnpm --filter @bsv/wallet-toolbox exec jest')[0]
    .replaceAll('${{ matrix.id }}', 'discovery')
  for (const shard of [1, 2, 3, 4]) {
    const result = spawnSync(
      '/bin/bash',
      ['-e', '-c', dispatch + '\nprintf "%s\\0" "${args[@]}"'],
      {
        cwd: REPOSITORY_ROOT,
        encoding: 'utf8',
        timeout: 10000,
        env: {
          ...process.env,
          WALLET_SHARD: String(shard),
          SYNC_LATENCY: '',
          NATIVE_COHORT: '',
          NATIVE_PAIR_COHORT: '',
          NATIVE_MERGE_COHORT: '',
          NATIVE_AUTH_COHORT: '',
          NATIVE_READ_COHORT: '',
          NATIVE_USER_COHORT: '',
          NATIVE_INTEGRITY_COHORT: '',
          POSTGRES_PASSWORD: 'synthetic-discovery-only',
          GITHUB_WORKSPACE: REPOSITORY_ROOT
        }
      }
    )
    assert.equal(result.status, 0, result.stderr)
    const args = result.stdout.split('\0').filter(Boolean)
    assert.ok(args.every(value => !value.startsWith('--testNamePattern')))
    assert.ok(args.includes(`--shard=${shard}/4`))
    ordinaryFiles.push(...discover(args))
  }
  const browserFiles = walletBrowserSuites.map(suite => join(REPOSITORY_ROOT, suite.file))
  assert.deepEqual(
    original.filter(file => !ordinaryFiles.includes(file)),
    [join(wallet, 'src/storage/snapshot/PackedIdbCurrentStructuredRead.test.ts')]
  )
  for (const file of original)
    assert.equal(
      ordinaryFiles.filter(value => value === file).length +
        browserFiles.filter(value => value === file).length,
      1
    )
  const browser = job.steps.find(step =>
    step.run?.includes('scripts/wallet-browser-ci.mjs capture')
  )
  assert.equal(browser.if, "matrix.id == 'shard-4'")
  assert.equal(browser.run.includes('--testNamePattern'), false)
  assert.notEqual(browser['continue-on-error'], true)
  const gate = workflow.jobs['coverage-upload'].steps.find(
    step => step.run === 'node scripts/wallet-browser-ci.mjs verify .coverage-artifacts'
  )
  assert.equal(gate.if, "needs.prepare.outputs.wallet == 'true'")
  assert.notEqual(gate['continue-on-error'], true)
})
