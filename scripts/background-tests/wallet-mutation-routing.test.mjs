import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPOSITORY_ROOT } from '../repository-health.mjs'
import { walletBrowserSuites } from '../wallet-browser-ci.mjs'
import { buildMutationTargets } from '../../governance/mutation-testing/targets.mjs'
import { selectedMutationPartition } from '../mutation-partitions.mjs'

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
      {
        cwd: wallet,
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 4194304,
        env: {
          ...process.env,
          JEST_SHARD_LANE: 'wallet-toolbox-coverage',
          JEST_SHARD_DURATIONS: join(REPOSITORY_ROOT, 'governance/ci-lane-durations.json')
        }
      }
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
  for (const shard of [1, 2, 3, 4, 5, 6]) {
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
          GITHUB_WORKSPACE: REPOSITORY_ROOT,
          JEST_SHARD_LANE: 'wallet-toolbox-coverage',
          JEST_SHARD_DURATIONS: join(REPOSITORY_ROOT, 'governance/ci-lane-durations.json')
        }
      }
    )
    assert.equal(result.status, 0, result.stderr)
    const args = result.stdout.split('\0').filter(Boolean)
    assert.ok(args.every(value => !value.startsWith('--testNamePattern')))
    assert.ok(args.includes(`--shard=${shard}/6`))
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
