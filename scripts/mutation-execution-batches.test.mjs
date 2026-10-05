import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildMutationTargets } from '../governance/mutation-testing/targets.mjs'
import { mutationExecutionMatrix, selectedMutationPartition } from './mutation-partitions.mjs'
import {
  mutationExecutionBatches,
  mutationExecutionDigest,
  verifyMutationExecutionBatches,
  verifyMutationExecutionIdentity
} from './mutation-execution-batches.mjs'
import { REPOSITORY_ROOT } from './repository-health.mjs'

const matrixFor = count => ({
  include: Array.from({ length: count }, (_, index) => ({
    target: `fixture-${index}`,
    partition: 'whole'
  }))
})

test('ordered execution batches preserve zero, boundary and multiple complete inventories', () => {
  for (const count of [0, 1, 255, 256, 257, 512, 513, 1000]) {
    const matrix = matrixFor(count),
      before = structuredClone(matrix)
    const batches = mutationExecutionBatches(matrix)
    assert.equal(batches.include.length, Math.ceil(count / 256))
    assert.deepEqual(
      batches.include.flatMap(row => row.executionMatrix.include),
      matrix.include
    )
    for (const [index, batch] of batches.include.entries()) {
      assert.equal(batch.batch, index + 1)
      assert.ok(
        batch.executionMatrix.include.length > 0 && batch.executionMatrix.include.length <= 256
      )
    }
    verifyMutationExecutionBatches(matrix, batches)
    assert.deepEqual(matrix, before)
  }
})

test('malformed, duplicate, sparse, decorated and oversized execution inventories fail closed', () => {
  const accessor = { partition: 'whole' }
  Object.defineProperty(accessor, 'target', {
    enumerable: true,
    get() {
      throw new Error('Getter must not execute')
    }
  })
  const decorated = { target: 'fixture', partition: 'whole' }
  Object.defineProperty(decorated, 'hidden', { value: true })
  for (const matrix of [
    null,
    {},
    { include: null },
    { include: Array(1) },
    { include: [null] },
    { include: [accessor] },
    { include: [decorated] },
    { include: [{ target: 'fixture', partition: 'whole', unknown: true }] },
    { include: [{ target: 'fixture', partition: 'whole;exit' }] },
    {
      include: [
        { target: 'fixture', partition: 'whole' },
        { target: 'fixture', partition: 'whole' }
      ]
    },
    { include: [], unknown: true },
    matrixFor(65537)
  ])
    assert.throws(() => mutationExecutionBatches(matrix))
  for (const maximum of [0, -1, 1.5, 257, Infinity, NaN])
    assert.throws(() => mutationExecutionBatches(matrixFor(1), maximum))
  assert.throws(() => mutationExecutionBatches(matrixFor(257), 1))
})

test('missing, repeated, unexpected and reordered batches cannot satisfy the original flat union', () => {
  const matrix = matrixFor(513),
    batches = mutationExecutionBatches(matrix)
  for (const altered of [
    { include: batches.include.slice(1) },
    { include: [...batches.include, batches.include[0]] },
    { include: [...batches.include].reverse() },
    mutationExecutionBatches(matrix, 128)
  ])
    assert.throws(() => verifyMutationExecutionBatches(matrix, altered))
  const altered = structuredClone(batches)
  altered.include[0].executionMatrix.include[0].target = 'unexpected'
  assert.throws(() => verifyMutationExecutionBatches(matrix, altered))
})

test('the real complete flat inventory crosses a scheduling boundary without changing any part configuration', () => {
  const targets = buildMutationTargets(REPOSITORY_ROOT),
    matrix = mutationExecutionMatrix(Object.keys(targets), targets)
  const before = structuredClone(matrix),
    batches = mutationExecutionBatches(matrix, 128)
  assert.ok(batches.include.length > 1)
  assert.deepEqual(
    batches.include.flatMap(row => row.executionMatrix.include),
    matrix.include
  )
  assert.deepEqual(matrix, before)
  for (const row of batches.include.flatMap(batch => batch.executionMatrix.include)) {
    const part = selectedMutationPartition(row.target, targets[row.target], row.partition)
    assert.deepEqual({ ...part, mutate: targets[row.target].mutate }, targets[row.target])
  }
})

test('every batch rejects a different source, run, attempt, archive, matrix or ordered slice', () => {
  const matrix = matrixFor(257),
    actual = {
      sourceSha: 'a'.repeat(40),
      runId: '100',
      runAttempt: '2',
      archiveDigest: 'b'.repeat(64),
      matrixDigest: mutationExecutionDigest(matrix),
      executionMatrix: matrix
    }
  for (const batch of mutationExecutionBatches(matrix).include) {
    const request = { ...actual, batch: batch.batch, executionMatrix: batch.executionMatrix }
    verifyMutationExecutionIdentity(request, actual)
    for (const field of ['sourceSha', 'runId', 'runAttempt', 'archiveDigest', 'matrixDigest']) {
      const digestWidth = field === 'sourceSha' ? 40 : 64
      const changed = field.startsWith('run') ? '3' : 'c'.repeat(digestWidth)
      assert.throws(() => verifyMutationExecutionIdentity({ ...request, [field]: changed }, actual))
      assert.throws(() =>
        verifyMutationExecutionIdentity({ ...request, [field]: undefined }, actual)
      )
    }
    for (const invalid of [0, 3, 1.5, '1'])
      assert.throws(() => verifyMutationExecutionIdentity({ ...request, batch: invalid }, actual))
    assert.throws(() =>
      verifyMutationExecutionIdentity({ ...request, executionMatrix: { include: [] } }, actual)
    )
    assert.throws(() =>
      verifyMutationExecutionIdentity(request, { ...actual, matrixDigest: 'c'.repeat(64) })
    )
  }
})

function job(source, name) {
  const start = source.indexOf(`\n  ${name}:\n`)
  assert.ok(start >= 0)
  const remaining = source.slice(start + 1)
  const end = remaining.search(/\n {2}[a-z][a-z0-9-]*:\n/)
  return end < 0 ? remaining : remaining.slice(0, end)
}

function stepScript(source, name) {
  const marker = `\n      - name: ${name}\n`
  assert.ok(source.includes(marker))
  const selected = source.slice(source.indexOf(marker) + marker.length)
  return /\n {8}run: \|\n([\s\S]*?)(?=\n {6}-|$)/
    .exec(selected)[1]
    .split('\n')
    .map(line => line.replace(/^ {10}/, ''))
    .join('\n')
}

test('actual caller output commands fail preparation when any planner or identity command fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'mutation-batch-command-'))
  const output = join(root, 'output')
  try {
    mkdirSync(join(root, 'bin'))
    writeFileSync(
      join(root, 'bin/node'),
      '#!/bin/sh\nif [ "$2" = "$FAIL_COMMAND" ]; then exit 42; fi\nprintf "result-%s\\n" "$2"\n',
      { mode: 0o755 }
    )
    for (const file of ['ci.yml', 'mutation-tests.yml']) {
      const source = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8')
      const script = stepScript(
        job(source, 'prepare'),
        'Pin complete immutable mutation execution batches'
      )
      for (const failing of ['', 'plan', 'digest', 'build-identity']) {
        writeFileSync(output, '')
        const result = spawnSync('/bin/bash', ['-e', '-o', 'pipefail', '-c', script], {
          env: { PATH: join(root, 'bin'), GITHUB_OUTPUT: output, FAIL_COMMAND: failing },
          encoding: 'utf8'
        })
        assert.equal(result.error, undefined)
        if (failing) {
          assert.equal(result.status, 42, `${file}: ${failing}`)
          assert.equal(readFileSync(output, 'utf8'), '')
        } else {
          assert.equal(result.status, 0)
          assert.equal(
            readFileSync(output, 'utf8'),
            'batches=result-plan\nmatrix-digest=result-digest\nidentity=result-build-identity\n'
          )
        }
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('actual reusable preflight rejects wrong profiles and stale original caller or artifact identity', () => {
  const source = readFileSync(
    new URL('../.github/workflows/mutation-execution.yml', import.meta.url),
    'utf8'
  )
  const script = stepScript(source, 'Require the original caller evidence profile')
  const original = {
    GITHUB_SHA: 'a'.repeat(40),
    GITHUB_RUN_ID: '100',
    GITHUB_RUN_ATTEMPT: '2',
    SOURCE_SHA: 'a'.repeat(40),
    SOURCE_RUN_ID: '100',
    SOURCE_RUN_ATTEMPT: '2',
    NODE_VERSION: 'v24.18.0',
    ARCHIVE_DIGEST: 'b'.repeat(64),
    ARTIFACT_ID: '300'
  }
  const execute = env =>
    spawnSync('/bin/bash', ['-e', '-o', 'pipefail', '-c', script], { env, encoding: 'utf8' })
  for (const [profile, mode, artifact] of [
    ['ci', 'diagnostic', 'build-outputs'],
    ['qualification', 'diagnostic', 'mutation-build-outputs-100-2'],
    ['qualification', 'full', 'mutation-build-outputs-100-2']
  ]) {
    const environment = {
      ...original,
      PROFILE: profile,
      CAMPAIGN_MODE: mode,
      ARTIFACT_NAME: artifact
    }
    assert.equal(execute(environment).status, 0)
    for (const field of [
      'SOURCE_SHA',
      'SOURCE_RUN_ID',
      'SOURCE_RUN_ATTEMPT',
      'NODE_VERSION',
      'ARCHIVE_DIGEST',
      'ARTIFACT_ID',
      'ARTIFACT_NAME'
    ]) {
      assert.notEqual(execute({ ...environment, [field]: 'different' }).status, 0, field)
      assert.notEqual(execute({ ...environment, [field]: '' }).status, 0, field)
    }
    for (const [invalidProfile, invalidMode] of [
      ['ci', 'full'],
      ['other', 'full'],
      ['qualification', 'other']
    ])
      assert.notEqual(
        execute({ ...environment, PROFILE: invalidProfile, CAMPAIGN_MODE: invalidMode }).status,
        0
      )
  }
})

test('both callers dispatch serial immutable batches and the reusable executor retains original profiles and gates', () => {
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const full = readFileSync(
    new URL('../.github/workflows/mutation-tests.yml', import.meta.url),
    'utf8'
  )
  const executor = readFileSync(
    new URL('../.github/workflows/mutation-execution.yml', import.meta.url),
    'utf8'
  )
  for (const [source, profile] of [
    [ci, 'ci'],
    [full, 'qualification']
  ]) {
    const caller = job(source, 'mutation-tests'),
      prepare = job(source, 'prepare')
    assert.match(caller, /max-parallel: 1\n/)
    assert.match(caller, /fail-fast: false/)
    assert.match(caller, /uses: \.\/\.github\/workflows\/mutation-execution\.yml/)
    assert.ok(caller.includes(`profile: ${profile}`))
    assert.match(
      caller,
      /matrix: \$\{\{ fromJSON\(needs\.prepare\.outputs\.mutation-batches\) \}\}/
    )
    for (const field of [
      'execution-matrix',
      'execution-batch',
      'selected-targets',
      'matrix-digest',
      'identity'
    ])
      assert.ok(caller.includes(`${field}:`))
    assert.doesNotMatch(caller, /continue-on-error|secrets:|runs-on:|timeout-minutes:/)
    assert.match(
      prepare,
      /BUILD_ARTIFACT_ID: \$\{\{ steps\.mutation-build\.outputs\.artifact-id \}\}/
    )
    assert.match(prepare, /BUILD_ARTIFACT_NAME: /)
    assert.match(prepare, /scripts\/mutation-execution-batches\.mjs build-identity/)
    assert.ok(prepare.indexOf('id: mutation-build') < prepare.indexOf('id: mutation-execution'))
  }
  assert.match(executor, /fail-fast: false/)
  assert.match(
    executor,
    /max-parallel: \$\{\{ inputs\.profile == 'qualification' && 20 \|\| 6 \}\}/
  )
  assert.match(executor, /ref: \$\{\{ fromJSON\(inputs\.identity\)\.sourceSha \}\}/)
  assert.match(executor, /persist-credentials: false/)
  assert.match(executor, /node-version: \$\{\{ fromJSON\(inputs\.identity\)\.nodeVersion \}\}/)
  assert.match(executor, /NODE_VERSION: \$\{\{ fromJSON\(inputs\.identity\)\.nodeVersion \}\}/)
  assert.match(executor, /pnpm install --frozen-lockfile --ignore-scripts/)
  assert.match(executor, /artifact-ids: \$\{\{ fromJSON\(inputs\.identity\)\.artifactId \}\}/)
  assert.ok(executor.indexOf('verify-execution') < executor.indexOf('tar --extract'))
  assert.ok(executor.indexOf('tar --extract') < executor.indexOf('scripts/mutation-testing.mjs'))
  assert.match(executor, /ci:diagnostic\|qualification:diagnostic\|qualification:full/)
  for (const binding of [
    'SOURCE_SHA',
    'SOURCE_RUN_ID',
    'SOURCE_RUN_ATTEMPT',
    'ARCHIVE_DIGEST',
    'ARTIFACT_ID'
  ])
    assert.ok(executor.includes(binding))
  assert.doesNotMatch(executor, /continue-on-error|secrets:|fail-fast: true/)
  assert.match(executor, /inputs\.profile == 'qualification' && matrix\.partition == 'whole'/)
  assert.match(executor, /mutation-final-qualification\.mjs capture/)
  assert.match(executor, /mutation-partition-evidence\.mjs capture/)
  assert.match(ci, /Incomplete, unordered or malformed execution batch union/)
  assert.match(full, /mutation-execution-batches\.mjs verify-batches/)
  assert.match(
    full,
    /Independently recheck every selected canonical partition before full qualification/
  )
  assert.match(full, /mutation-final-qualification\.mjs verify/)
})
