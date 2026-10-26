import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseArguments,
  REPOSITORY_ROOT,
  selectAffectedMutationTargets
} from './mutation-testing.mjs'
import { buildMutationTargets } from '../governance/mutation-testing/targets.mjs'
import {
  partitionMutationTarget,
  canonicalMutationPartitions,
  selectedMutationPartition,
  mutationExecutionMatrix,
  partitionedMutationTargets,
  refineMutationPartition,
  applyPartitionComponentTests,
  automaticPlan,
  longestFirst,
  admitSchedulingPlans,
  schedulingTopology
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

test('primary sync partitions preserve complete contracts before dependencies are installed', () => {
  const canonical = buildMutationTargets(REPOSITORY_ROOT)['wallet-snapshot-sync']
  const parts = partitionMutationTarget('wallet-snapshot-sync', canonical)
  assert.deepEqual(
    parts.map(part => part.id),
    ['session', 'checkpoint', 'copy', 'storage', 'primary']
  )
  assert.deepEqual(parts.flatMap(part => part.target.mutate).sort(), [...canonical.mutate].sort())
  const owners = new Map()
  for (const part of parts) {
    assert.deepEqual(part.target, { ...canonical, mutate: part.target.mutate })
    assert.equal(part.target.runnerOptions, canonical.runnerOptions)
    for (const specification of part.target.mutate) {
      const file = specification.replace(/:\d+(?:-\d+)?$/, '')
      assert.ok(!owners.has(file) || owners.get(file) === part.id)
      owners.set(file, part.id)
    }
  }
  assert.equal(owners.get('src/storage/WalletStorageManager.ts'), 'primary')
  assert.equal(owners.get('src/storage/StorageKnex.ts'), 'storage')
  assert.equal(owners.get('src/storage/snapshot/SnapshotSync.ts'), 'session')
  const helper = 'src/storage/snapshot/FuturePrimaryHelper.ts'
  const future = partitionMutationTarget('wallet-snapshot-sync', {
    ...canonical,
    mutate: [...canonical.mutate, helper]
  })
  assert.deepEqual(future[0].target.mutate, [...parts[0].target.mutate, helper])
  assert.equal(selectedMutationPartition('wallet-snapshot-sync', canonical), canonical)
  const targets = buildMutationTargets(REPOSITORY_ROOT)
  assert.ok(mutationExecutionMatrix(Object.keys(targets), targets).include.length <= 256)
})

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
  const parts = canonicalMutationPartitions('wallet-retained-snapshot', retained)
  assert.throws(
    () => partitionMutationTarget('wallet-retained-snapshot', retained),
    /Unknown or duplicate original execution partition/
  )
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
    'wallet-retained-snapshot': buildMutationTargets(REPOSITORY_ROOT)['wallet-retained-snapshot'],
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
    assert.deepEqual(part.target, { ...canonical, mutate: part.target.mutate })
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
      partition,
      wallet_native: true
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
    assert.deepEqual(part.target, { ...canonical, mutate: part.target.mutate })
    assert.equal(part.target.runnerOptions, canonical.runnerOptions)
  }
  assert.deepEqual(parts[0].target.mutate, [
    'src/storage/snapshot/archive/SnapshotArchiveProtocol.ts',
    'src/storage/snapshot/archive/KnexSnapshotArchiveRpc.ts',
    'src/storage/snapshot/archive/SnapshotArchiveTransport.ts',
    'src/storage/snapshot/RemoteSnapshotSyncContentProtocol.ts',
    'src/storage/snapshot/journal/KnexSnapshotJournalDataRpc.ts',
    'src/storage/snapshot/journal/KnexSnapshotJournalFieldRpc.ts',
    'src/storage/snapshot/journal/RemoteSnapshotJournalFieldDestination.ts',
    'src/storage/snapshot/journal/SnapshotJournalFieldRpcProtocol.ts',
    'src/storage/snapshot/journal/SnapshotJournalFieldUploadRequest.ts',
    'src/storage/snapshot/journal/openStoredSnapshotJournalFieldArchive.ts',
    'src/storage/snapshot/journal/RemoteSnapshotJournalDataDestination.ts',
    'src/storage/snapshot/journal/SnapshotJournalArchiveProtocol.ts',
    'src/storage/snapshot/journal/SnapshotJournalArchiveTransport.ts',
    'src/storage/snapshot/journal/SnapshotJournalDataProtocol.ts',
    'src/storage/snapshot/journal/openRemoteSnapshotJournalArchive.ts',
    'src/storage/snapshot/journal/SnapshotJournalFieldArchiveProtocol.ts',
    'src/storage/snapshot/journal/SnapshotJournalFieldArchiveTransport.ts',
    'src/storage/snapshot/journal/openRemoteSnapshotJournalFieldArchive.ts'
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
      partition,
      wallet_native: true
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
      'receipts',
      'capture-fence',
      'connections',
      'capture-backend',
      'capture',
      'collection',
      'maintenance',
      'maintenance-fence',
      'maintenance-task'
    ],
    'revision'
  ],
  ['wallet-snapshot-archive', ['store', 'capture', 'source'], 'capture'],
  ['wallet-snapshot-remote-reader', ['admission', 'lease', 'rows', 'page'], 'admission']
]) {
  test(`${id} preserves canonical whole-file ownership, configuration and future source coverage`, () => {
    const canonical = buildMutationTargets(REPOSITORY_ROOT)[id]
    const parts = canonicalMutationPartitions(id, canonical)
    assert.deepEqual(
      parts.map(part => part.id),
      expected
    )
    assert.deepEqual(parts.flatMap(part => part.target.mutate).sort(), [...canonical.mutate].sort())
    const owners = new Map()
    for (const part of parts) {
      const { mutate } = part.target
      assert.deepEqual(part.target, { ...canonical, mutate })
      assert.equal(part.target.runnerOptions, canonical.runnerOptions)
      for (const specification of mutate) {
        const file = specification.replace(/:\d+(?:-\d+)?$/, '')
        assert.ok(!owners.has(file) || owners.get(file) === part.id)
        owners.set(file, part.id)
      }
    }
    const helper = 'src/storage/snapshot/FutureHelper.ts'
    const extended = { ...canonical, mutate: [...canonical.mutate, helper, `${helper}:1-20`] }
    const expanded = canonicalMutationPartitions(id, extended)
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

test('native platform routing follows the actual package, including every canonical partition', () => {
  const wallet = {
    ...target,
    packageDirectory: 'packages/wallet/wallet-toolbox',
    mutate: ['src/utility/runInSeries.ts']
  }
  const values = mutationExecutionMatrix(
    ['ordinary-name', 'wallet-snapshot-sync', 'wallet-looking-name'],
    {
      'ordinary-name': wallet,
      'wallet-snapshot-sync': wallet,
      'wallet-looking-name': {
        ...target,
        packageDirectory: 'packages/sdk',
        mutate: ['src/auth/Peer.ts:1-2']
      }
    }
  ).include
  assert.ok(
    values
      .filter(value => value.target !== 'wallet-looking-name')
      .every(value => value.wallet_native === true)
  )
  assert.equal(
    values.find(value => value.target === 'wallet-looking-name').wallet_native,
    undefined
  )
  const targets = buildMutationTargets(REPOSITORY_ROOT)
  for (const value of mutationExecutionMatrix(Object.keys(targets), targets).include) {
    assert.equal(
      value.wallet_native === true,
      targets[value.target].packageDirectory === 'packages/wallet/wallet-toolbox'
    )
  }
})

test('canonical serializer partitions keep every complete module and the full original test configuration', () => {
  const canonical = buildMutationTargets(REPOSITORY_ROOT)['wallet-portable-canonical-chunks']
  const parts = partitionMutationTarget('wallet-portable-canonical-chunks', canonical)
  assert.deepEqual(
    parts.map(part => part.id),
    ['writer', 'helpers', 'bounds', 'value', 'parts']
  )
  assert.deepEqual(parts.flatMap(part => part.target.mutate).sort(), [...canonical.mutate].sort())
  const owners = new Set()
  for (const part of parts) {
    assert.deepEqual(part.target, { ...canonical, mutate: part.target.mutate })
    assert.equal(part.target.runnerOptions, canonical.runnerOptions)
    for (const file of part.target.mutate) {
      assert.ok(!owners.has(file))
      owners.add(file)
    }
  }
  const helper = 'src/storage/portable/FutureCanonicalHelper.ts'
  const future = partitionMutationTarget('wallet-portable-canonical-chunks', {
    ...canonical,
    mutate: [...canonical.mutate, helper]
  })
  assert.deepEqual(future.find(part => part.id === 'helpers').target.mutate, [
    'src/utility/promiseFromSync.ts',
    'src/utility/utf16CodeUnitAt.ts',
    helper
  ])
  assert.equal(selectedMutationPartition('wallet-portable-canonical-chunks', canonical), canonical)
  const targets = buildMutationTargets(REPOSITORY_ROOT)
  assert.ok(mutationExecutionMatrix(Object.keys(targets), targets).include.length <= 256)
})

function refinementFixture() {
  const source = Buffer.from('const one = 1\n\n// no mutant here\nconst two = 2\n'),
    base = {
      id: 'whole',
      target: {
        packageDirectory: 'package',
        mutate: ['src/code.ts'],
        runnerOptions: { jest: { config: { testMatch: ['all-original-tests'] } } }
      }
    },
    unit = {
      packageDirectory: 'package',
      originalMutate: ['src/code.ts'],
      sourceHashes: { 'src/code.ts': createHash('sha256').update(source).digest('hex') },
      canonicalCount: 2,
      parts: [
        { id: 'range-001', count: 1, mutate: ['src/code.ts:1-1'] },
        { id: 'range-002', count: 1, mutate: ['src/code.ts:4-4'] }
      ]
    }
  return { source, base, unit }
}
test('source-bound refinements retain the identical full runner and own future helpers in full', () => {
  const { source, base, unit } = refinementFixture()
  const parts = refineMutationPartition(base, unit, () => source)
  assert.deepEqual(
    parts.map(part => part.id),
    ['range-001', 'range-002']
  )
  for (const part of parts) {
    assert.equal(part.target.runnerOptions, base.target.runnerOptions)
    assert.deepEqual({ ...part.target, mutate: base.target.mutate }, base.target)
  }
  const future = refineMutationPartition(
    { ...base, target: { ...base.target, mutate: [...base.target.mutate, 'src/FutureHelper.ts'] } },
    unit,
    () => source
  )
  assert.deepEqual(future[0].target.mutate, ['src/code.ts:1-1', 'src/FutureHelper.ts'])
  assert.deepEqual(future[1].target.mutate, parts[1].target.mutate)
})
test('stale source, changed original specifications and malformed or overlapping ranges fail closed', () => {
  const { source, base, unit } = refinementFixture()
  assert.throws(
    () =>
      refineMutationPartition(base, unit, () => Buffer.concat([source, Buffer.from('// changed')])),
    /source changed/
  )
  assert.throws(
    () =>
      refineMutationPartition(
        { ...base, target: { ...base.target, mutate: ['src/code.ts:1-2'] } },
        unit,
        () => source
      ),
    /specifications changed/
  )
  for (const change of [
    value => {
      value.parts[1].mutate = ['src/code.ts:1-4']
    },
    value => {
      value.parts[1].mutate = ['src/code.ts:4-99']
    },
    value => {
      value.parts[1].mutate = ['../outside.ts:1-1']
    },
    value => {
      value.parts[1].mutate = ['src/*.ts']
    },
    value => {
      value.parts[1].mutate = ['src/code.ts:0-1']
    },
    value => {
      value.parts[1].mutate = ['src/code.ts:4-3']
    },
    value => {
      value.parts[1].id = value.parts[0].id
    },
    value => {
      value.parts[1].id = 'whole'
    },
    value => {
      value.parts[1].count = 0
    },
    value => {
      value.parts[1].mutate = []
    },
    value => {
      value.canonicalCount = 3
    },
    value => {
      value.sourceHashes['src/extra.ts'] = value.sourceHashes['src/code.ts']
    },
    value => {
      delete value.sourceHashes['src/code.ts']
    },
    value => {
      value.sourceHashes['src/code.ts'] = 'x'.repeat(64)
    },
    value => {
      value.packageDirectory = '../outside'
    }
  ]) {
    const changed = structuredClone(unit)
    change(changed)
    assert.throws(() => refineMutationPartition(base, changed, () => source))
  }
})

test('sqlite bootstrap components change only that source-bound partition and retain the full functional universe', () => {
  const canonical = buildMutationTargets(REPOSITORY_ROOT)['wallet-retained-snapshot']
  const parts = partitionMutationTarget('wallet-retained-snapshot', canonical)
  const children = parts.filter(part => /^sqlite-bootstrap-\d{3}$/.test(part.id))
  assert.equal(children.length, 6)
  const selected = children[0].target
  assert.deepEqual(
    selectAffectedMutationTargets({ 'wallet-retained-snapshot': canonical }, [
      'scripts/mutation-partitions.mjs'
    ]),
    ['wallet-retained-snapshot']
  )
  assert.deepEqual(
    selectAffectedMutationTargets({ 'wallet-retained-snapshot': canonical }, [
      'scripts/mutation-partitions.mjs.extra'
    ]),
    []
  )
  assert.equal(selected.runnerOptions.jest.config.testMatch.length, 9)
  assert.ok(
    selected.runnerOptions.jest.config.testMatch.includes(
      '<rootDir>/src/storage/snapshot/RetainedReadSnapshot.property.test.ts'
    )
  )
  for (const child of children) assert.deepEqual(child.target.runnerOptions, selected.runnerOptions)
  for (const part of parts.filter(part => !children.includes(part)))
    assert.equal(part.target.runnerOptions, canonical.runnerOptions)
  assert.equal(selectedMutationPartition('wallet-retained-snapshot', canonical), canonical)
  const original = canonicalMutationPartitions('wallet-retained-snapshot', canonical)
  assert.deepEqual(
    parts
      .filter(part => !children.includes(part))
      .flatMap(part => part.target.mutate)
      .sort(),
    original
      .filter(part => part.id !== 'sqlite-bootstrap')
      .flatMap(part => part.target.mutate)
      .sort()
  )
  assert.deepEqual(selected.runnerOptions, {
    ...canonical.runnerOptions,
    jest: {
      ...canonical.runnerOptions.jest,
      config: {
        ...canonical.runnerOptions.jest.config,
        testMatch: selected.runnerOptions.jest.config.testMatch
      }
    }
  })
})

test('component topology refuses stale source, missing properties, unknown suites and another partition', () => {
  const canonical = buildMutationTargets(REPOSITORY_ROOT)['wallet-retained-snapshot']
  const base = canonicalMutationPartitions('wallet-retained-snapshot', canonical).find(
    part => part.id === 'sqlite-bootstrap'
  )
  const selection = canonical.componentTestPartitions['sqlite-bootstrap']
  const read = file => readFileSync(join(REPOSITORY_ROOT, canonical.packageDirectory, file))
  for (const patch of [
    { mutate: [...selection.mutate, 'src/future.ts'] },
    { sourceHashes: {} },
    { sourceHashes: { ...selection.sourceHashes, 'src/extra.ts': 'a'.repeat(64) } },
    { tests: [] },
    { tests: [...selection.tests, selection.tests[0]] },
    {
      tests: selection.tests.filter(file => !file.endsWith('RetainedReadSnapshot.property.test.ts'))
    },
    ...[
      '../escape.test.ts',
      '/outside.test.ts',
      'src/**/*.test.ts',
      'src/unknown.test.ts',
      canonical.requiredFunctionalTests[0]
    ].map(file => ({ tests: [...selection.tests, file] }))
  ])
    assert.throws(() => applyPartitionComponentTests(base, { ...selection, ...patch }, read))
  assert.throws(
    () => applyPartitionComponentTests(base, selection, () => Buffer.from('changed source')),
    /source changed/
  )
  assert.throws(
    () =>
      partitionMutationTarget('wallet-retained-snapshot', {
        ...canonical,
        componentTestPartitions: { missing: selection }
      }),
    /Unknown component/
  )
  const before = JSON.stringify(canonical)
  applyPartitionComponentTests(base, selection, read)
  assert.equal(JSON.stringify(canonical), before)
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
  assert.equal(automaticPlan('t', target, 150), undefined)
  // Never measured: the pessimistic estimate (680 code lines) splits it.
  const unmeasured = automaticPlan('t', target, undefined)
  assert.equal(new Set(unmeasured.files.values()).size, 4)
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

test('optional scheduling cannot displace required rows or exceed the original ceiling', () => {
  const candidates = [
    { targetId: 'large', parts: 8, plan: {} },
    { targetId: 'fits', parts: 4, plan: {} },
    { targetId: 'later', parts: 2, plan: {} }
  ]
  assert.deepEqual([...admitSchedulingPlans(253, candidates).keys()], ['fits'])
  assert.throws(() => admitSchedulingPlans(257, []), /ceiling/)
  assert.throws(() => admitSchedulingPlans(253, [{ targetId: 'bad', parts: 0 }]), /Invalid/)
  const targets = buildMutationTargets(REPOSITORY_ROOT)
  const full = mutationExecutionMatrix(Object.keys(targets), targets).include
  assert.ok(full.length <= 256)
  for (const id of Object.keys(targets)) {
    const selected = mutationExecutionMatrix([id], targets).include
    assert.deepEqual(
      selected,
      full.filter(row => row.target === id)
    )
  }
})

test('zero-weight source units cannot crash automatic group ordering or lose source ranges', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ts-stack-zero-weight-'))
  mkdirSync(join(directory, 'src'))
  writeFileSync(join(directory, 'src/empty.ts'), '// empty\n')
  writeFileSync(join(directory, 'src/also-empty.ts'), '// also empty\n')
  writeFileSync(join(directory, 'src/used.ts'), 'export const value = 1\n')
  const target = {
    packageDirectory: directory,
    mutate: ['src/empty.ts', 'src/also-empty.ts', 'src/used.ts']
  }
  const plan = automaticPlan('zero-weight', target, 2000)
  assert.ok(plan)
  assert.equal(plan.files.size, 3)
  assert.ok([...plan.files.values()].every(id => typeof id === 'string'))
})

test('scheduling regeneration accepts previous stale hashes without weakening execution checks', () => {
  const targets = buildMutationTargets(REPOSITORY_ROOT)
  const manifest = JSON.parse(
    readFileSync(join(REPOSITORY_ROOT, 'governance/mutation-testing/execution-partitions.json'))
  )
  const changed = structuredClone(manifest.units)
  for (const unit of changed)
    for (const file of Object.keys(unit.sourceHashes)) unit.sourceHashes[file] = '0'.repeat(64)
  assert.equal(schedulingTopology(targets, changed).executionRows, 256)
  assert.throws(() => schedulingTopology(targets, [...changed, changed[0]]), /duplicate/)
  const extra = { target: 'unknown', existingPartition: 'whole', parts: [{}] }
  assert.throws(() => schedulingTopology(targets, [...changed, extra]), /Unknown/)
})

test('automatic plans cut a slow class between members but never inside a method', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ts-stack-auto-members-'))
  mkdirSync(join(directory, 'src'), { recursive: true })
  const methods = Array.from({ length: 6 }, (_, method) => [
    `  private step${method}(value: number): number {`,
    ...Array.from({ length: 20 }, (_, line) => `    if (value > ${method * 100 + line}) value--`),
    `    helper${method}(value)`,
    '    return value',
    '  }'
  ]).flat()
  const lines = [
    'class Parser {',
    '  constructor(private readonly text: string) {}',
    ...methods,
    '}'
  ]
  writeFileSync(join(directory, 'src/parser.ts'), lines.join('\n'))
  const target = { packageDirectory: directory, mutate: ['src/parser.ts'] }
  const plan = automaticPlan('t', target, 1000)
  const cuts = plan.lines.get('src/parser.ts')
  assert.ok(cuts.length >= 2)
  // Every cut starts a class member at exactly two spaces, never a statement
  // inside a method body.
  for (const [, marker] of cuts.slice(1)) assert.match(marker, /^ {2}private step\d\(/)

  // Two-space lines outside a class (function bodies) are never cut points.
  const functions = Array.from({ length: 6 }, (_, block) => [
    `function run${block}(value: number): number {`,
    ...Array.from({ length: 20 }, (_, line) => `  check${block}x${line}(value)`),
    '  return value',
    '}'
  ]).flat()
  writeFileSync(join(directory, 'src/functions.ts'), functions.join('\n'))
  const functionPlan = automaticPlan(
    't',
    { packageDirectory: directory, mutate: ['src/functions.ts'] },
    1000
  )
  for (const [, marker] of functionPlan.lines.get('src/functions.ts').slice(1))
    assert.match(marker, /^function run\d\(/)

  // A template and a two-space call inside a method look like members. They
  // must not be cuts, and the method's regex braces must not hide later members.
  const traps = [
    'class Parser {',
    '  constructor(private readonly text: string) {}',
    '  private step0(value: number): number {',
    ...Array.from({ length: 90 }, (_, line) => `    value = value + ${line}`),
    '    const source = `}',
    '  private nested0(value: number): number {',
    '    return value',
    '  }`',
    '  helper0(value)',
    '    if (/^[0-9a-f]{4}$/.test(String(value))) value++',
    ...Array.from({ length: 90 }, (_, line) => `    value = value + ${line + 90}`),
    '    return value',
    '  }',
    ...Array.from({ length: 3 }, (_, method) => [
      `  private step${method + 1}(value: number): number {`,
      ...Array.from({ length: 40 }, (_, line) => `    value = value + ${method * 100 + line}`),
      '    return value',
      '  }'
    ]).flat(),
    '}'
  ]
  writeFileSync(join(directory, 'src/traps.ts'), traps.join('\n'))
  const trapPlan = automaticPlan(
    't',
    { packageDirectory: directory, mutate: ['src/traps.ts'] },
    1000
  )
  const trapCuts = trapPlan.lines.get('src/traps.ts')
  assert.ok(trapCuts.length >= 2)
  for (const [, marker] of trapCuts.slice(1)) {
    assert.match(marker, /^ {2}(?:constructor\(|private step\d\()/)
    assert.doesNotMatch(marker, /nested|helper/)
  }
  const trapParts = partitionMutationTarget('t', {
    packageDirectory: directory,
    mutate: ['src/traps.ts']
  })
  const ranges = trapParts
    .flatMap(part => part.target.mutate)
    .map(spec => spec.split(':')[1].split('-').map(Number))
    .sort((left, right) => left[0] - right[0])
  assert.equal(ranges[0][0], 1)
  assert.equal(ranges.at(-1)[1], traps.length)
  for (let index = 1; index < ranges.length; index += 1)
    assert.equal(ranges[index][0], ranges[index - 1][1] + 1)
})
