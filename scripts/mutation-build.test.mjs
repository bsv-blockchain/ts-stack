import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { executeMutationBuilds, mutationBuildDependencies } from './mutation-build.mjs'

const wallet = '@bsv/wallet-toolbox',
  application = '@bsv/output-knowledge'

function childFixture(t, failure = '') {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'mutation-build-child-'))),
    script = join(directory, 'build-child.mjs'),
    log = join(directory, 'builds.jsonl'),
    calls = []
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  writeFileSync(
    script,
    `import {appendFileSync} from 'node:fs';
const args=process.argv.slice(2), stage=args[0]==='--filter'?args[1]:'current';
appendFileSync(process.env.TS_STACK_TEST_BUILD_LOG,JSON.stringify({args,cwd:process.cwd()})+'\\n');
if (!(args.length===1&&args[0]==='build') && !(args.length===3&&args[0]==='--filter'&&args[2]==='build')) process.exit(67);
if(process.env.TS_STACK_TEST_BUILD_FAILURE===stage) process.exit(17);
if(process.env.TS_STACK_TEST_BUILD_FAILURE==='signal:'+stage) process.kill(process.pid,'SIGTERM');
`
  )
  const env = {
    ...process.env,
    TS_STACK_TEST_BUILD_LOG: log,
    TS_STACK_TEST_BUILD_FAILURE: failure
  }
  return {
    directory,
    script,
    env,
    calls,
    options: {
      cwd: directory,
      env,
      run(command, args, options) {
        assert.equal(command, 'pnpm')
        assert.equal(options.shell, false)
        calls.push(args)
        return spawnSync(process.execPath, [script, ...args], options)
      }
    },
    records: () =>
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line))
  }
}

test('executes the actual ordered prerequisite and sandbox children without shell operators', t => {
  const f = childFixture(t),
    args = ['--dependency', wallet, '--dependency', application]
  assert.equal(executeMutationBuilds(args, f.options), 0)
  assert.deepEqual(f.records(), [
    { args: ['--filter', wallet, 'build'], cwd: f.directory },
    { args: ['--filter', application, 'build'], cwd: f.directory },
    { args: ['build'], cwd: f.directory }
  ])
  // The old compound argv reaches the first executable as one invalid build.
  const old = spawnSync(
    process.execPath,
    [
      f.script,
      '--filter',
      wallet,
      'build',
      '&&',
      'pnpm',
      '--filter',
      application,
      'build',
      '&&',
      'pnpm',
      'build'
    ],
    { cwd: f.directory, env: f.env, shell: false }
  )
  assert.equal(old.status, 67)
})

test('retains the current sandbox build when no prerequisite is needed', t => {
  const f = childFixture(t)
  assert.equal(executeMutationBuilds([], f.options), 0)
  assert.deepEqual(f.calls, [['build']])
})

for (const [failure, completed] of [
  [wallet, 1],
  [application, 2],
  ['current', 3]
]) {
  test('stops immediately after the actual failed ' + failure + ' child', t => {
    const f = childFixture(t, failure)
    assert.equal(
      executeMutationBuilds(['--dependency', wallet, '--dependency', application], f.options),
      17
    )
    assert.equal(f.records().length, completed)
  })
}

test('refuses to continue after an actual prerequisite is terminated by a signal', t => {
  const f = childFixture(t, 'signal:' + wallet)
  assert.throws(
    () => executeMutationBuilds(['--dependency', wallet, '--dependency', application], f.options),
    /Mutation build terminated by SIGTERM/
  )
  assert.equal(f.records().length, 1)
})

test('propagates a spawn error before executing the sandbox build', () => {
  const failure = new Error('Owned child could not start'),
    calls = []
  assert.throws(
    () =>
      executeMutationBuilds(['--dependency', wallet], {
        run(command, args) {
          calls.push({ command, args })
          return { error: failure }
        }
      }),
    error => error === failure
  )
  assert.equal(calls.length, 1)
})

test('rejects malformed, duplicate or operator-bearing dependency arguments before any build', () => {
  for (const args of [
    ['--dependency'],
    ['--unknown', wallet],
    ['--dependency', wallet, '--dependency', wallet],
    ['--dependency', wallet + ';false'],
    ['--dependency', wallet, '&&', 'pnpm'],
    ['--dependency', 'other/package']
  ])
    assert.throws(() => mutationBuildDependencies(args), /Expected distinct --dependency/)
  assert.deepEqual(mutationBuildDependencies(['--dependency', wallet]), [wallet])
})
