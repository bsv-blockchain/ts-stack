import assert from 'node:assert/strict'
import test from 'node:test'
import { buildMutationTargets } from '../governance/mutation-testing/targets.mjs'
import { REPOSITORY_ROOT } from './repository-health.mjs'
import { parseArguments } from './mutation-testing.mjs'
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

test('root records keep whole files, original tests and future sources under one canonical gate', () => {
  const root = {
    testRunner: 'jest',
    runnerOptions: { jest: { config: { testMatch: ['all-original-root-tests'] } } },
    additionalInputs: ['src/root-eviction/**', 'all-original-fixtures'],
    mutate: [
      'src/root-eviction/RootEvictionRequests.ts',
      'src/root-eviction/RootEvictionServingRecords.ts',
      'src/root-eviction/FutureHelper.ts'
    ]
  }
  const parts = partitionMutationTarget('root-eviction-records', root)
  assert.deepEqual(
    parts.map(part => part.id),
    ['requests', 'serving']
  )
  assert.deepEqual(parts.flatMap(part => part.target.mutate).sort(), [...root.mutate].sort())
  assert.deepEqual(parts[0].target.mutate, [root.mutate[0], root.mutate[2]])
  assert.deepEqual(parts[1].target.mutate, [root.mutate[1]])
  for (const part of parts) {
    assert.equal(part.target.runnerOptions, root.runnerOptions)
    assert.equal(part.target.additionalInputs, root.additionalInputs)
    assert.equal(part.target.testRunner, root.testRunner)
  }
  assert.equal(selectedMutationPartition('root-eviction-records', root), root)
  assert.throws(() => selectedMutationPartition('root-eviction-records', root, 'missing'))
  for (const specification of ['src/**/*.ts', '!src/Root.ts', '../outside.ts', '/outside.ts'])
    assert.throws(() =>
      partitionMutationTarget('root-eviction-records', { mutate: [specification] })
    )
  const targets = { 'root-eviction-records': root, other: { mutate: ['src/whole.ts'] } }
  assert.deepEqual(mutationExecutionMatrix(['other', 'root-eviction-records'], targets).include, [
    { target: 'other', partition: 'whole' },
    { target: 'root-eviction-records', partition: 'requests' },
    { target: 'root-eviction-records', partition: 'serving' }
  ])
  assert.deepEqual(partitionedMutationTargets(['other', 'root-eviction-records'], targets), [
    'root-eviction-records'
  ])
})

for (const [targetId, fallback, expected] of [
  [
    'wallet-recovery-encoding',
    'binary',
    {
      binary: [
        'src/storage/actionRecovery/ActionRecoveryEncoding.ts',
        'src/storage/actionRecovery/ActionRecoveryEncodingLimits.ts'
      ],
      json: ['src/storage/actionRecovery/ActionRecoveryJSON.ts']
    }
  ],
  [
    'proposal-channel-storage',
    'factory',
    {
      factory: [
        'src/proposals/SQLiteProposalChannelStore.ts',
        'src/lookup/SQLiteLookupSessionBootstrap.ts'
      ],
      writer: ['src/proposals/SQLiteProposalFeedWriter.ts'],
      inventory: ['src/proposals/SQLiteProposalFeedInventory.ts'],
      capacity: ['src/proposals/ProposalChannelFeedCapacity.ts'],
      records: ['src/proposals/ProposalChannelFeedRecords.ts'],
      privacy: ['src/proposals/ProposalFeedPrivacy.ts'],
      policy: ['src/proposals/AuthorDocumentPolicy.ts']
    }
  ],
  [
    'output-knowledge-proposal-core',
    'worker',
    {
      worker: ['src/BitcoinKnowledge.ts'],
      state: ['src/BitcoinKnowledgeState.ts'],
      store: ['src/KnowledgeStore.ts'],
      proposal: ['src/proposals/ProposalLocalState.ts', 'src/proposals/ProposalKnowledgeView.ts']
    }
  ],
  [
    'proposal-journal-send',
    'journal',
    {
      journal: [
        'src/proposals/SQLiteProposalJournal.ts',
        'src/proposals/SQLiteProposalJournalStore.ts'
      ],
      state: ['src/proposals/ProposalJournalState.ts'],
      domain: ['src/storage/SQLiteTransactionDomain.ts']
    }
  ]
])
  test(`${targetId} retains every complete file and original qualification input`, () => {
    const canonical = buildMutationTargets(REPOSITORY_ROOT)[targetId]
    const parts = partitionMutationTarget(targetId, canonical)
    assert.deepEqual(Object.fromEntries(parts.map(part => [part.id, part.target.mutate])), expected)
    const union = parts.flatMap(part => part.target.mutate)
    assert.deepEqual(union.slice().sort(), canonical.mutate.slice().sort())
    assert.equal(new Set(union).size, union.length)
    for (const part of parts) {
      const { mutate: _part, ...rest } = part.target
      const { mutate: _whole, ...original } = canonical
      assert.deepEqual(rest, original)
      assert.equal(part.target.runnerOptions, canonical.runnerOptions)
      assert.equal(part.target.additionalInputs, canonical.additionalInputs)
    }
    const future = { ...canonical, mutate: [...canonical.mutate, 'src/FutureCompanion.ts'] }
    const next = partitionMutationTarget(targetId, future)
    assert.ok(
      next.find(part => part.id === fallback).target.mutate.includes('src/FutureCompanion.ts')
    )
    assert.equal(selectedMutationPartition(targetId, canonical), canonical)
    assert.throws(() => selectedMutationPartition(targetId, canonical, 'absent'))
  })

test('protected ledger parts preserve every complete file and all canonical configuration', () => {
  const canonical = buildMutationTargets(REPOSITORY_ROOT)['protected-ledger']
  const parts = partitionMutationTarget('protected-ledger', canonical)
  assert.deepEqual(
    parts.map(part => part.id),
    ['store', 'codec']
  )
  assert.deepEqual(parts.flatMap(part => part.target.mutate).sort(), [...canonical.mutate].sort())
  for (const part of parts) {
    const { mutate: _partial, ...actual } = part.target
    const { mutate: _whole, ...original } = canonical
    assert.deepEqual(actual, original)
  }
  const future = { ...canonical, mutate: [...canonical.mutate, 'src/private/FutureCompanion.ts'] }
  assert.ok(
    partitionMutationTarget('protected-ledger', future)
      .find(part => part.id === 'store')
      .target.mutate.includes('src/private/FutureCompanion.ts')
  )
})

test('private publication parts preserve every complete file and all canonical configuration', () => {
  const canonical = buildMutationTargets(REPOSITORY_ROOT)['private-publication-state']
  const parts = partitionMutationTarget('private-publication-state', canonical)
  assert.deepEqual(
    parts.map(part => part.id),
    ['store', 'identity', 'records', 'progress']
  )
  assert.deepEqual(parts.flatMap(part => part.target.mutate).sort(), [...canonical.mutate].sort())
  for (const part of parts) {
    const { mutate: _partial, ...actual } = part.target
    const { mutate: _whole, ...original } = canonical
    assert.deepEqual(actual, original)
  }
  const future = { ...canonical, mutate: [...canonical.mutate, 'src/private/FutureCompanion.ts'] }
  assert.ok(
    partitionMutationTarget('private-publication-state', future)
      .find(part => part.id === 'store')
      .target.mutate.includes('src/private/FutureCompanion.ts')
  )
})

test('lineage graph parts retain complete layout and transition code and all canonical work', () => {
  const canonical = buildMutationTargets(REPOSITORY_ROOT)['revenue-lineage-graph']
  const parts = partitionMutationTarget('revenue-lineage-graph', canonical)
  assert.deepEqual(
    parts.map(part => part.id),
    ['layout', 'transition']
  )
  assert.deepEqual(parts.flatMap(part => part.target.mutate).sort(), [...canonical.mutate].sort())
  for (const part of parts) {
    const { mutate: _partial, ...actual } = part.target
    const { mutate: _whole, ...original } = canonical
    assert.deepEqual(actual, original)
  }
  const future = {
    ...canonical,
    mutate: [...canonical.mutate, 'src/revenue-listing/FutureCompanion.ts']
  }
  assert.ok(
    partitionMutationTarget('revenue-lineage-graph', future)
      .find(part => part.id === 'layout')
      .target.mutate.includes('src/revenue-listing/FutureCompanion.ts')
  )
})
