import assert from 'node:assert/strict'
import test from 'node:test'
import { parseArguments, REPOSITORY_ROOT } from './mutation-testing.mjs'
import { buildMutationTargets } from '../governance/mutation-testing/targets.mjs'
import {
  partitionMutationTarget,
  selectedMutationPartition,
  mutationExecutionMatrix,
  partitionedMutationTargets
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
    ['core', 'client', 'transport']
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
      { target: 'sdk-auth-http', partition: 'core' },
      { target: 'sdk-auth-http', partition: 'client' },
      { target: 'sdk-auth-http', partition: 'transport' },
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

test('service execution preserves the complete canonical union and all configuration in every part', () => {
  const canonical = buildMutationTargets(REPOSITORY_ROOT)['wallet-snapshot-remote-service']
  const parts = partitionMutationTarget('wallet-snapshot-remote-service', canonical)
  assert.deepEqual(
    parts.map(part => part.id),
    ['persistence', 'controller', 'guard', 'backend']
  )
  assert.deepEqual(parts.flatMap(part => part.target.mutate).sort(), [...canonical.mutate].sort())
  assert.equal(new Set(parts.flatMap(part => part.target.mutate)).size, canonical.mutate.length)
  for (const part of parts) {
    const { mutate: _partMutate, ...partConfig } = part.target
    const { mutate: _canonicalMutate, ...canonicalConfig } = canonical
    assert.deepEqual(partConfig, canonicalConfig)
    assert.equal(part.target.runnerOptions, canonical.runnerOptions)
  }
  assert.deepEqual(parts[1].target.mutate, [
    'src/storage/snapshot/archive/KnexSnapshotArchiveService.ts'
  ])
  assert.deepEqual(parts[2].target.mutate, [
    'src/storage/snapshot/archive/SnapshotArchiveGuard.ts',
    'src/storage/snapshot/archive/SnapshotArchiveGuardRegistry.ts'
  ])
  assert.deepEqual(parts[3].target.mutate, [
    'src/storage/snapshot/archive/SnapshotArchiveGuardBackend.ts'
  ])
  const future = {
    ...canonical,
    mutate: [...canonical.mutate, 'src/storage/snapshot/archive/FutureHelper.ts']
  }
  const expanded = partitionMutationTarget('wallet-snapshot-remote-service', future)
  assert.equal(expanded[0].id, 'persistence')
  assert.ok(expanded[0].target.mutate.includes('src/storage/snapshot/archive/FutureHelper.ts'))
  assert.equal(selectedMutationPartition('wallet-snapshot-remote-service', canonical), canonical)
  assert.throws(() =>
    selectedMutationPartition('wallet-snapshot-remote-service', canonical, 'missing')
  )
  for (const specification of ['src/**/*.ts', '!src/helper.ts', '../outside.ts', '/outside.ts']) {
    assert.throws(() =>
      partitionMutationTarget('wallet-snapshot-remote-service', { mutate: [specification] })
    )
  }
  const targets = { before: target, 'wallet-snapshot-remote-service': canonical, after: target }
  assert.deepEqual(mutationExecutionMatrix(Object.keys(targets), targets).include, [
    { target: 'before', partition: 'whole' },
    ...['persistence', 'controller', 'guard', 'backend'].map(partition => ({
      target: 'wallet-snapshot-remote-service',
      partition
    })),
    { target: 'after', partition: 'whole' }
  ])
})

test('HTTP execution preserves every canonical range, full configuration and future fallback', () => {
  const canonical = buildMutationTargets(REPOSITORY_ROOT)['wallet-snapshot-remote-http']
  const parts = partitionMutationTarget('wallet-snapshot-remote-http', canonical)
  assert.deepEqual(
    parts.map(part => part.id),
    ['protocol', 'client', 'server']
  )
  const original = [...canonical.mutate].sort()
  const actual = parts.flatMap(part => part.target.mutate)
  assert.deepEqual([...actual].sort(), original)
  assert.equal(new Set(actual).size, original.length)
  for (const part of parts) {
    const { mutate: _partMutate, ...partConfig } = part.target
    const { mutate: _canonicalMutate, ...canonicalConfig } = canonical
    assert.deepEqual(partConfig, canonicalConfig)
    assert.equal(part.target.runnerOptions, canonical.runnerOptions)
  }
  assert.deepEqual(parts[0].target.mutate, [
    'src/storage/snapshot/archive/SnapshotArchiveProtocol.ts',
    'src/storage/snapshot/archive/KnexSnapshotArchiveRpc.ts',
    'src/storage/snapshot/archive/SnapshotArchiveTransport.ts'
  ])
  for (const [index, file] of [
    [1, 'StorageClientBase.ts'],
    [2, 'StorageServer.ts']
  ]) {
    assert.deepEqual(
      parts[index].target.mutate,
      canonical.mutate.filter(specification =>
        specification.startsWith(`src/storage/remoting/${file}:`)
      )
    )
    assert.ok(parts[index].target.mutate.length > 1)
  }
  const helper = 'src/storage/snapshot/archive/FutureHttpHelper.ts'
  const expanded = partitionMutationTarget('wallet-snapshot-remote-http', {
    ...canonical,
    mutate: [...canonical.mutate, helper]
  })
  assert.equal(expanded[0].id, 'protocol')
  assert.deepEqual(expanded[0].target.mutate, [...parts[0].target.mutate, helper])
  assert.equal(selectedMutationPartition('wallet-snapshot-remote-http', canonical), canonical)
  assert.throws(() =>
    selectedMutationPartition('wallet-snapshot-remote-http', canonical, 'missing')
  )
  for (const specification of ['src/**/*.ts', '!src/helper.ts', '../outside.ts', '/outside.ts']) {
    assert.throws(() =>
      partitionMutationTarget('wallet-snapshot-remote-http', { mutate: [specification] })
    )
  }
  const targets = { before: target, 'wallet-snapshot-remote-http': canonical, after: target }
  assert.deepEqual(mutationExecutionMatrix(Object.keys(targets), targets).include, [
    { target: 'before', partition: 'whole' },
    ...['protocol', 'client', 'server'].map(partition => ({
      target: 'wallet-snapshot-remote-http',
      partition
    })),
    { target: 'after', partition: 'whole' }
  ])
})

for (const [id, expected, fallback] of [
  [
    'wallet-retained-snapshot',
    [
      'lifecycle',
      'reader',
      'profile-index',
      'relation-index',
      'certificate-index',
      'global-index',
      'global-mysql',
      'global-sqlite',
      'global-bootstrap',
      'global-triggers',
      'sqlite-identity',
      'sqlite-membership',
      'sqlite-generation',
      'sqlite-bootstrap',
      'sqlite-retirement',
      'storage'
    ],
    'lifecycle'
  ],
  [
    'wallet-snapshot-journal',
    [
      'revision',
      'page',
      'clock',
      'sqlite-observers',
      'mysql-observers',
      'bootstrap',
      'high-water',
      'mysql-source',
      'sqlite-generation',
      'mysql-intent',
      'mysql-generation',
      'receipts'
    ],
    'revision'
  ],
  ['wallet-snapshot-archive', ['store', 'capture', 'source'], 'capture'],
  ['wallet-snapshot-remote-reader', ['admission', 'lease', 'rows', 'page'], 'admission']
]) {
  test(`${id} preserves canonical whole-file ownership, configuration and future source coverage`, () => {
    const canonical = buildMutationTargets(REPOSITORY_ROOT)[id]
    const parts = partitionMutationTarget(id, canonical)
    assert.deepEqual(
      parts.map(part => part.id),
      expected
    )
    assert.deepEqual(parts.flatMap(part => part.target.mutate).sort(), [...canonical.mutate].sort())
    const owners = new Map()
    for (const part of parts) {
      const { mutate, ...configuration } = part.target
      const { mutate: _canonicalMutate, ...canonicalConfiguration } = canonical
      assert.deepEqual(configuration, canonicalConfiguration)
      assert.equal(part.target.runnerOptions, canonical.runnerOptions)
      for (const specification of mutate) {
        const file = specification.replace(/:\d+(?:-\d+)?$/, '')
        assert.ok(!owners.has(file) || owners.get(file) === part.id)
        owners.set(file, part.id)
      }
    }
    const helper = 'src/storage/snapshot/FutureHelper.ts'
    const extended = { ...canonical, mutate: [...canonical.mutate, helper, `${helper}:1-20`] }
    const expanded = partitionMutationTarget(id, extended)
    assert.deepEqual(
      expanded.flatMap(part => part.target.mutate).sort(),
      [...extended.mutate].sort()
    )
    assert.deepEqual(expanded.find(part => part.id === fallback).target.mutate.slice(-2), [
      helper,
      `${helper}:1-20`
    ])
    assert.equal(selectedMutationPartition(id, canonical), canonical)
    assert.throws(() => selectedMutationPartition(id, canonical, 'missing'))
  })
}
