import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArguments } from './mutation-testing.mjs'
import {
  partitionMutationTarget,
  selectedMutationPartition,
  mutationExecutionMatrix,
  partitionedMutationTargets,
  longestFirst,
  automaticPlan
} from './mutation-partitions.mjs'
const target = {
  mutate: [
    'src/auth/Peer.ts:5-10',
    'src/auth/Peer.ts:8-20',
    'src/auth/clients/AuthFetch.ts:1-20',
    'src/auth/clients/AuthFetch.ts:40-50',
    'src/auth/transports/SimplifiedFetchTransport.ts:5-90',
    'src/auth/FutureHelper.ts'
  ],
  runnerOptions: { jest: { config: { testMatch: ['all-original-tests'] } } }
}
test('execution partitions preserve complete original specifications and identical full test configuration', () => {
  const parts = partitionMutationTarget('sdk-auth-http', target)
  assert.deepEqual(
    parts.map(part => part.id),
    ['peer', 'client', 'transport', 'core']
  )
  assert.deepEqual(parts.flatMap(part => part.target.mutate).sort(), [...target.mutate].sort())
  const owner = new Map()
  for (const part of parts) {
    assert.equal(part.target.runnerOptions, target.runnerOptions)
    for (const specification of part.target.mutate) {
      const file = specification.split(':')[0]
      assert.ok(!owner.has(file) || owner.get(file) === part.id)
      owner.set(file, part.id)
    }
  }
  assert.equal(owner.get('src/auth/FutureHelper.ts'), 'core')
  assert.equal(selectedMutationPartition('sdk-auth-http', target), target)
  assert.throws(() => selectedMutationPartition('other', target, 'core'), /Unknown/)
})
test('empty, wildcard, traversing and unknown partition selections fail closed', () => {
  for (const specification of ['src/**/*.ts', '!src/auth/Peer.ts', '../outside.ts', '/outside.ts'])
    assert.throws(() => partitionMutationTarget('sdk-auth-http', { mutate: [specification] }))
  assert.throws(() => partitionMutationTarget('sdk-auth-http', { mutate: [] }))
  assert.throws(() => selectedMutationPartition('sdk-auth-http', target, 'missing'))
  assert.throws(() =>
    mutationExecutionMatrix(['sdk-auth-http', 'sdk-auth-http'], { 'sdk-auth-http': target })
  )
  assert.throws(() => mutationExecutionMatrix(['unknown'], {}))
})
test('matrix expands only canonical SDKAuth while preserving original target order and other campaigns', () => {
  assert.deepEqual(
    mutationExecutionMatrix(['before', 'sdk-auth-http', 'after'], {
      before: target,
      'sdk-auth-http': target,
      after: target
    }).include,
    [
      { target: 'before', partition: 'whole' },
      { target: 'sdk-auth-http', partition: 'peer' },
      { target: 'sdk-auth-http', partition: 'client' },
      { target: 'sdk-auth-http', partition: 'transport' },
      { target: 'sdk-auth-http', partition: 'core' },
      { target: 'after', partition: 'whole' }
    ]
  )
})

test('partition command mode requires one exact target without weakening existing mode validation', () => {
  const defaults = {
    all: false,
    list: false,
    targets: [],
    affectedFile: undefined,
    base: undefined
  }
  assert.deepEqual(parseArguments(['--target', 'sdk-auth-http', '--partition', 'core']), {
    ...defaults,
    targets: ['sdk-auth-http'],
    partition: 'core'
  })
  assert.deepEqual(parseArguments(['--all']), { ...defaults, all: true })
  for (const args of [
    ['--all', '--partition', 'core'],
    ['--list', '--partition', 'core'],
    ['--affected-file', 'paths', '--partition', 'core'],
    ['--target', 'sdk-auth-http', '--target', 'other', '--partition', 'core'],
    ['--target', 'sdk-auth-http', '--base', 'HEAD'],
    ['--target', 'sdk-auth-http', '--all'],
    ['--target', 'sdk-auth-http', '--partition']
  ])
    assert.throws(() => parseArguments(args))
})

test('retained partitions preserve complete lifecycle/reader/storage unions and future additions', () => {
  const retained = {
    testRunner: 'jest',
    runnerOptions: { jest: { config: { testMatch: ['all-original-retained-tests'] } } },
    mutate: [
      'src/storage/snapshot/RetainedReadSnapshot.ts',
      'src/storage/snapshot/KnexWalletReadSnapshot.ts',
      'src/storage/StorageKnex.ts:225-275',
      'src/storage/StorageKnex.ts:250-280',
      'src/storage/StorageProvider.ts:540-562',
      'src/storage/snapshot/FutureHelper.ts'
    ]
  }
  const parts = partitionMutationTarget('wallet-retained-snapshot', retained)
  assert.deepEqual(
    parts.map(part => part.id),
    ['lifecycle', 'reader', 'storage']
  )
  assert.deepEqual(parts.flatMap(part => part.target.mutate).sort(), [...retained.mutate].sort())
  for (const part of parts) {
    assert.equal(part.target.runnerOptions, retained.runnerOptions)
    assert.equal(part.target.testRunner, retained.testRunner)
  }
  assert.deepEqual(parts[0].target.mutate, [retained.mutate[0], retained.mutate[5]])
  assert.deepEqual(parts[2].target.mutate, retained.mutate.slice(2, 5))
  for (const specification of [
    'src/**/*.ts',
    '!src/StorageKnex.ts',
    '../outside.ts',
    '/outside.ts'
  ])
    assert.throws(() =>
      partitionMutationTarget('wallet-retained-snapshot', { mutate: [specification] })
    )
  assert.throws(() => selectedMutationPartition('wallet-retained-snapshot', retained, 'missing'))
  const targets = {
    'sdk-auth-http': target,
    'wallet-retained-snapshot': retained,
    other: { mutate: ['src/whole.ts'] }
  }
  assert.deepEqual(partitionedMutationTargets(['other'], targets), [])
  assert.deepEqual(
    partitionedMutationTargets(['wallet-retained-snapshot', 'other', 'sdk-auth-http'], targets),
    ['wallet-retained-snapshot', 'sdk-auth-http']
  )
  assert.deepEqual(partitionedMutationTargets([], targets), [])
  assert.throws(() =>
    partitionedMutationTargets(['wallet-retained-snapshot'], { 'sdk-auth-http': target })
  )
  assert.throws(() => partitionedMutationTargets(['sdk-auth-http', 'sdk-auth-http'], targets))
})

test('line partitions intersect every original range with contiguous segments that cover the file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ts-stack-line-partition-'))
  mkdirSync(join(directory, 'src/brc52'), { recursive: true })
  const lines = Array.from({ length: 40 }, (_, index) => `// line ${index + 1}`)
  const markers = [
    'function exactKeys(',
    'function strictSignature(',
    'function graph(',
    'export function validateBRC52Disclosure(',
    'export function parseBRC52Envelope('
  ]
  markers.forEach((marker, index) => (lines[5 + index * 6] = `${marker}) {}`))
  writeFileSync(join(directory, 'src/brc52/envelope.ts'), lines.join('\n'))
  const envelope = {
    packageDirectory: directory,
    runnerOptions: { jest: { config: { testMatch: ['all-original-envelope-tests'] } } },
    mutate: ['src/brc52/envelope.ts', 'src/brc52/envelope.ts:8-20', 'src/brc52/future.ts']
  }
  const parts = partitionMutationTarget('brc52-envelope', envelope)
  assert.deepEqual(
    parts.map(part => [part.id, part.target.mutate]),
    [
      ['envelope-1', ['src/brc52/envelope.ts:1-5', 'src/brc52/future.ts']],
      ['envelope-2', ['src/brc52/envelope.ts:6-11', 'src/brc52/envelope.ts:8-11']],
      ['envelope-3', ['src/brc52/envelope.ts:12-17', 'src/brc52/envelope.ts:12-17']],
      ['envelope-4', ['src/brc52/envelope.ts:18-23', 'src/brc52/envelope.ts:18-20']],
      ['envelope-5', ['src/brc52/envelope.ts:24-29']],
      ['envelope-6', ['src/brc52/envelope.ts:30-40']]
    ]
  )
  for (const part of parts) assert.equal(part.target.runnerOptions, envelope.runnerOptions)

  // A moved, missing or duplicated marker fails closed instead of shifting mutants.
  writeFileSync(
    join(directory, 'src/brc52/envelope.ts'),
    [...lines, 'function graph() {}'].join('\n')
  )
  assert.throws(() => partitionMutationTarget('brc52-envelope', envelope), /exactly one line/)
  writeFileSync(
    join(directory, 'src/brc52/envelope.ts'),
    lines.filter(line => !line.startsWith('function graph(')).join('\n')
  )
  assert.throws(() => partitionMutationTarget('brc52-envelope', envelope), /exactly one line/)
  const reordered = [...lines]
  ;[reordered[5], reordered[11]] = [reordered[11], reordered[5]]
  writeFileSync(join(directory, 'src/brc52/envelope.ts'), reordered.join('\n'))
  assert.throws(() => partitionMutationTarget('brc52-envelope', envelope), /out of order/)
  assert.throws(
    () => partitionMutationTarget('brc52-envelope', { mutate: ['src/brc52/envelope.ts'] }),
    /package directory/
  )
})

test('longest-first scheduling reorders but never adds, drops or duplicates parts', () => {
  const matrix = {
    include: [
      { target: 'short', partition: 'whole' },
      { target: 'split', partition: 'a' },
      { target: 'new', partition: 'whole' },
      { target: 'split', partition: 'b' },
      { target: 'tie', partition: 'whole' }
    ]
  }
  const seconds = { 'short/whole': 40, 'split/a': 300, 'split/b': 90, 'tie/whole': 90 }
  const ordered = longestFirst(matrix, seconds).include
  assert.deepEqual(ordered, [
    { target: 'new', partition: 'whole' },
    { target: 'split', partition: 'a' },
    { target: 'split', partition: 'b' },
    { target: 'tie', partition: 'whole' },
    { target: 'short', partition: 'whole' }
  ])
  const key = row => `${row.target}/${row.partition}`
  assert.deepEqual(ordered.map(key).sort(), matrix.include.map(key).sort())
  assert.deepEqual(longestFirst({ include: [] }, seconds), { include: [] })
})

test('automatic plans split slow multi-file targets by file and leave fast or single-file ones whole', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ts-stack-auto-partition-'))
  mkdirSync(join(directory, 'src'), { recursive: true })
  const write = (file, lines) =>
    writeFileSync(
      join(directory, file),
      Array.from({ length: lines }, (_, i) => `x(${i})`).join('\n')
    )
  write('src/a.ts', 300)
  write('src/b.ts', 200)
  write('src/c.ts', 120)
  write('src/d.ts', 60)
  const target = {
    packageDirectory: directory,
    runnerOptions: { jest: { config: { testMatch: ['all-original-tests'] } } },
    mutate: ['src/a.ts', 'src/b.ts:1-150', 'src/b.ts:120-200', 'src/c.ts', 'src/d.ts']
  }
  // Measured as fast: one job, whatever the size.
  assert.equal(automaticPlan('t', target, 200), undefined)
  // Never measured: the pessimistic estimate (680 code lines) splits it.
  const unmeasured = automaticPlan('t', target, undefined)
  assert.equal(new Set(unmeasured.files.values()).size, 3)
  // Measured slow: parts by time, capped by the number of files.
  const plan = automaticPlan('t', target, 5000)
  assert.equal(new Set(plan.files.values()).size, 4)
  assert.match(plan.files.get('src/a.ts'), /^auto-\d$/)
  // Every range of a file stays in one part, and nothing is dropped.
  const owner = new Map()
  for (const specification of target.mutate) {
    const file = specification.replace(/:\d+(?:-\d+)?$/, '')
    const id = plan.files.get(file)
    assert.ok(id)
    assert.ok(!owner.has(file) || owner.get(file) === id)
    owner.set(file, id)
  }
  // Single-file, wildcard and directory-less targets never auto-split.
  assert.equal(automaticPlan('t', { ...target, mutate: ['src/a.ts'] }, 5000), undefined)
  assert.equal(automaticPlan('t', { ...target, mutate: ['src/*.ts'] }, 5000), undefined)
  assert.equal(automaticPlan('t', { mutate: target.mutate }, 5000), undefined)
  // Explicit plans keep priority over automatic ones.
  assert.deepEqual(
    partitionMutationTarget('sdk-auth-http', { ...target, mutate: ['src/a.ts'] }).map(p => p.id),
    ['core']
  )
})

test('automatic plans cut a slow single file at unique top-level declarations', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ts-stack-auto-lines-'))
  mkdirSync(join(directory, 'src'), { recursive: true })
  const blocks = Array.from({ length: 8 }, (_, block) => [
    `export function step${block}(value: number): number {`,
    ...Array.from({ length: 30 }, (_, line) => `  value = value + ${block * 100 + line}`),
    '  return value',
    '}'
  ]).flat()
  writeFileSync(join(directory, 'src/one.ts'), blocks.join('\n'))
  const target = { packageDirectory: directory, mutate: ['src/one.ts'] }
  // Fast: stays whole.
  assert.equal(automaticPlan('t', target, 100), undefined)
  // Slow: cut into balanced segments that each start at a declaration.
  const plan = automaticPlan('t', target, 1000)
  const cuts = plan.lines.get('src/one.ts')
  assert.ok(cuts.length >= 2)
  assert.equal(cuts[0][1], null)
  for (const [, marker] of cuts.slice(1)) assert.match(marker, /^export function step\d\(/)
  const parts = partitionMutationTarget('t', target)
  // Partitions re-derive the same plan and cover the file contiguously.
  const ranges = parts
    .flatMap(part => part.target.mutate)
    .map(spec => spec.split(':')[1].split('-').map(Number))
    .sort((left, right) => left[0] - right[0])
  assert.equal(ranges[0][0], 1)
  assert.equal(ranges.at(-1)[1], blocks.length)
  for (let index = 1; index < ranges.length; index += 1)
    assert.equal(ranges[index][0], ranges[index - 1][1] + 1)
})
