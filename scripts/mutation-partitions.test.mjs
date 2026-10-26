import assert from 'node:assert/strict'
import test from 'node:test'
import { buildMutationTargets } from '../governance/mutation-testing/targets.mjs'
import { REPOSITORY_ROOT } from './repository-health.mjs'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArguments } from './mutation-testing.mjs'
import { mutationExecutionBatches } from './mutation-execution-batches.mjs'
import {
  partitionMutationTarget,
  selectedMutationPartition,
  mutationExecutionMatrix,
  partitionedMutationTargets,
  semanticMutationStarts,
  longestFirst,
  automaticPlan
} from './mutation-partitions.mjs'
const compareSpecifications = (left, right) => left.localeCompare(right)
const target = {
  packageDirectory: 'packages/sdk',
  mutate: [
    'src/auth/Peer.ts:5-10',
    'src/auth/Peer.ts:8-20',
    'src/auth/clients/AuthFetch.ts:1-20',
    'src/auth/clients/AuthFetch.ts:40-50',
    'src/auth/transports/SimplifiedFetchTransport.ts:5-90',
    'src/auth/FutureHelper.ts',
    'src/auth/AuthMessageValidation.ts:1-20',
    'src/overlay-tools/OutputLookupProtocol.ts:1-30',
    'src/overlay-tools/OutputLookupTransport.ts',
    'src/overlay-tools/internal/OutputFiniteHTTP.ts'
  ],
  runnerOptions: { jest: { config: { testMatch: ['all-original-tests'] } } }
}

const semanticTargets = [
  'wallet-recovery-store',
  'wallet-recovery-plan',
  'lch-overlay-covenant-terms',
  'private-purchase-state',
  'private-purchase-coordination',
  'private-purchase-native-clock',
  'revenue-listing-purchase',
  'wallet-recovery-codec',
  'overlay-proposal-admission',
  'private-publication-coordination',
  'root-eviction-records',
  'root-eviction-journal',
  'root-eviction-storage',
  'overlay-private-publication-admission',
  'private-publication-state',
  'private-publication-service',
  'wallet-recovery-encoding',
  'private-purchase-http',
  'sdk-auth-http'
]
const sourceLines = (target, specifications) =>
  new Set(
    specifications.flatMap(specification => {
      const file = specification.replace(/:\d+(?:-\d+)?$/, '')
      const match = /:(\d+)(?:-(\d+))?$/.exec(specification)
      const lines = readFileSync(
        new URL(`../${target.packageDirectory}/${file}`, import.meta.url),
        'utf8'
      ).split('\n').length
      const start = match ? Number(match[1]) : 1
      const end = match ? Number(match[2] ?? match[1]) : lines
      return Array.from({ length: end - start + 1 }, (_, index) => `${file}:${start + index}`)
    })
  )

test('semantic execution ranges retain the complete source line union and every original setting without installed tools', () => {
  const targets = buildMutationTargets(REPOSITORY_ROOT)
  for (const id of semanticTargets) {
    const original = targets[id],
      parts = partitionMutationTarget(id, original)
    assert.ok(parts.length > 1)
    assert.equal(new Set(parts.map(part => part.id)).size, parts.length)
    assert.deepEqual(
      sourceLines(
        original,
        parts.flatMap(part => part.target.mutate)
      ),
      sourceLines(original, original.mutate)
    )
    for (const part of parts) {
      assert.deepEqual(
        { ...part.target, mutate: original.mutate },
        original,
        `${id}/${part.id} changed an original target setting`
      )
      assert.equal(part.target.runnerOptions, original.runnerOptions)
      assert.equal(part.target.additionalInputs, original.additionalInputs)
    }
    assert.equal(selectedMutationPartition(id, original), original)
  }
  assert.equal(Object.keys(targets).length, 156)
  const matrix = mutationExecutionMatrix(Object.keys(targets), targets)
  assert.equal(matrix.include.length, 607)
  const batches = mutationExecutionBatches(matrix)
  assert.deepEqual(
    batches.include.map(batch => batch.executionMatrix.include.length),
    [256, 256, 95]
  )
  assert.deepEqual(
    batches.include.flatMap(batch => batch.executionMatrix.include),
    matrix.include
  )
})

test('standing covenant terms retain their seven semantic partitions and complete historical and current companions', () => {
  const canonical = buildMutationTargets(REPOSITORY_ROOT)['lch-overlay-covenant-terms'],
    parts = partitionMutationTarget('lch-overlay-covenant-terms', canonical)
  assert.deepEqual(
    parts.map(part => part.id),
    ['terms-1', 'terms-2', 'terms-3', 'terms-4', 'terms-5', 'terms-6', 'consent-1']
  )
  for (const file of [
    'src/overlayAcquisitionCovenantTerms.ts',
    'src/overlayAcquisitionCovenantProfileTerms.ts'
  ]) {
    assert.ok(parts[0].target.mutate.includes(file))
    assert.equal(
      parts.flatMap(part => part.target.mutate).filter(value => value === file).length,
      1
    )
  }
  assert.deepEqual(parts.at(-1).target.mutate, ['src/overlayAcquisitionConsent.ts:1-80'])
})

test('recovery store partitions preserve its canonical interval and future companion sources', () => {
  const id = 'wallet-recovery-store',
    canonical = buildMutationTargets(REPOSITORY_ROOT)[id],
    parts = partitionMutationTarget(id, canonical),
    future = 'src/storage/actionRecovery/FutureStore.ts',
    extended = { ...canonical, mutate: [...canonical.mutate, future] },
    next = partitionMutationTarget(id, extended)
  assert.deepEqual(
    parts.map(part => part.id),
    Array.from({ length: 9 }, (_, i) => `store-${i + 1}`)
  )
  const originalLines = sourceLines(canonical, canonical.mutate)
  for (const part of parts) {
    for (const line of sourceLines(canonical, part.target.mutate))
      assert.ok(originalLines.has(line))
    assert.deepEqual(selectedMutationPartition(id, canonical, part.id), part.target)
  }
  assert.deepEqual(next.find(part => part.id === 'remaining').target.mutate, [future])
  assert.equal(next.flatMap(part => part.target.mutate).filter(file => file === future).length, 1)
  for (const part of next) assert.deepEqual({ ...part.target, mutate: extended.mutate }, extended)
})

test('recovery plan partitions retain call-only ranges and future companion sources', () => {
  const id = 'wallet-recovery-plan',
    canonical = buildMutationTargets(REPOSITORY_ROOT)[id],
    parts = partitionMutationTarget(id, canonical),
    future = 'src/storage/actionRecovery/FuturePlan.ts',
    extended = { ...canonical, mutate: [...canonical.mutate, future] },
    next = partitionMutationTarget(id, extended)
  assert.deepEqual(
    parts.map(part => part.id),
    ['plan-1', 'construction-1', 'construction-2']
  )
  assert.equal(parts[0].target.mutate.length, 1)
  assert.equal(parts[1].target.mutate.length, 5)
  assert.equal(parts[2].target.mutate.length, 2)
  assert.deepEqual(next.find(part => part.id === 'remaining').target.mutate, [future])
  assert.equal(next.flatMap(part => part.target.mutate).filter(file => file === future).length, 1)
  for (const part of next) {
    assert.deepEqual({ ...part.target, mutate: extended.mutate }, extended)
    assert.deepEqual(selectedMutationPartition(id, extended, part.id), part.target)
  }
})

test('root storage keeps the entire companion module in its nonempty first database part', () => {
  const id = 'root-eviction-storage',
    canonical = buildMutationTargets(REPOSITORY_ROOT)[id],
    parts = partitionMutationTarget(id, canonical),
    companion = 'src/root-eviction/RootEvictionStorage.ts',
    database = 'src/root-eviction/SQLiteRootEvictionDatabase.ts'
  assert.deepEqual(
    parts.map(part => part.id),
    ['database-1', 'database-2', 'database-3', 'database-4', 'database-5']
  )
  assert.ok(parts[0].target.mutate.includes(companion))
  assert.equal(
    parts.flatMap(part => part.target.mutate).filter(file => file === companion).length,
    1
  )
  for (const mutate of [[companion], [`${database}:134-224`, companion]])
    assert.throws(
      () => partitionMutationTarget(id, { ...canonical, mutate }),
      /nonempty source destination/
    )
  const future = 'src/root-eviction/FutureCompanion.ts',
    extended = { ...canonical, mutate: [...canonical.mutate, future] },
    next = partitionMutationTarget(id, extended)
  assert.deepEqual(next.find(part => part.id === 'remaining').target.mutate, [future])
  assert.equal(
    next.flatMap(part => part.target.mutate).filter(file => file === companion).length,
    1
  )
  for (const part of next) assert.deepEqual({ ...part.target, mutate: extended.mutate }, extended)
})

test('new ranged targets retain future sources once and require complete root aggregation', () => {
  const targets = buildMutationTargets(REPOSITORY_ROOT)
  for (const id of semanticTargets.slice(-6)) {
    const canonical = targets[id],
      future = 'src/FutureCompanion.ts',
      extended = { ...canonical, mutate: [...canonical.mutate, future] },
      parts = partitionMutationTarget(id, extended)
    assert.equal(
      parts.flatMap(part => part.target.mutate).filter(file => file === future).length,
      1
    )
    for (const part of parts)
      assert.deepEqual({ ...part.target, mutate: extended.mutate }, extended)
  }
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'),
    aggregate = workflow.slice(workflow.indexOf('\n  mutation-quality:')),
    verify = aggregate.indexOf('name: Require every selected canonical partition target gate')
  assert.ok(verify > 0)
  const downloads = aggregate
    .split(/\n {6}- /)
    .filter(
      step =>
        step.startsWith('uses: actions/download-artifact@') &&
        step.includes('pattern: mutation-*\n')
    )
  assert.equal(downloads.length, 1)
  assert.ok(downloads[0].includes("if: needs.prepare.outputs.partition-targets != '[]'"))
  assert.ok(downloads[0].includes('path: .mutation-parts-raw'))
  assert.ok(aggregate.indexOf(downloads[0]) < verify)
  assert.match(aggregate.slice(verify), /MUTATION_MATRIX:/)
  assert.match(aggregate.slice(verify), /select\(\.target == \$target and \.partition != "whole"\)/)
  assert.match(aggregate.slice(verify), /\.mutation-parts-raw\/mutation-\$target-\$partition/)
  for (const id of ['root-eviction-journal', 'root-eviction-storage'])
    assert.ok(partitionedMutationTargets(Object.keys(targets), targets).includes(id), id)
})

test('semantic ranges retain future files and the exact original overlapping line union', () => {
  const original = buildMutationTargets(REPOSITORY_ROOT)['private-purchase-state'],
    file = 'src/private/PrivatePurchaseProgress.ts',
    future = 'src/private/FuturePurchaseHelper.ts',
    selected = { ...original, mutate: [`${file}:120-160`, `${file}:150-180`, future] },
    parts = partitionMutationTarget('private-purchase-state', selected)
  assert.deepEqual(
    parts.map(part => part.id),
    ['progress-1', 'progress-2', 'progress-3', 'progress-4', 'remaining']
  )
  assert.deepEqual(
    parts.flatMap(part => part.target.mutate),
    [
      `${file}:120-133`,
      `${file}:134-139`,
      `${file}:140-152`,
      `${file}:150-152`,
      `${file}:153-160`,
      `${file}:153-180`,
      future
    ]
  )
  for (const part of parts) assert.equal(part.target.runnerOptions, original.runnerOptions)
  for (const mutate of [
    [],
    ['src/**/*.ts'],
    ['../outside.ts'],
    [`${file}:10-5`],
    [`${file}:9007199254740992`]
  ])
    assert.throws(() => partitionMutationTarget('private-purchase-state', { ...original, mutate }))
})
test('execution partitions preserve complete original specifications and identical full test configuration', () => {
  const parts = partitionMutationTarget('sdk-auth-http', target)
  assert.deepEqual(
    parts.map(part => part.id),
    ['peer', 'client', 'transport', 'core', 'lookup', 'finite-http']
  )
  assert.deepEqual(
    parts.flatMap(part => part.target.mutate).sort(compareSpecifications),
    [...target.mutate].sort(compareSpecifications)
  )
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
  assert.equal(owner.get('src/auth/AuthMessageValidation.ts'), 'core')
  assert.equal(owner.get('src/overlay-tools/OutputLookupProtocol.ts'), 'lookup')
  assert.equal(owner.get('src/overlay-tools/OutputLookupTransport.ts'), 'lookup')
  assert.equal(owner.get('src/overlay-tools/internal/OutputFiniteHTTP.ts'), 'finite-http')
  assert.equal(selectedMutationPartition('sdk-auth-http', target), target)
  assert.deepEqual(
    selectedMutationPartition('sdk-auth-http', target, 'message-validation').mutate,
    ['src/auth/AuthMessageValidation.ts:1-20']
  )
  assert.throws(
    () => selectedMutationPartition('other', { mutate: ['src/whole.ts'] }, 'core'),
    /Unknown/
  )
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
      before: { mutate: ['src/whole.ts'] },
      'sdk-auth-http': target,
      after: { mutate: ['src/whole.ts'] }
    }).include,
    [
      { target: 'before', partition: 'whole' },
      { target: 'sdk-auth-http', partition: 'peer' },
      { target: 'sdk-auth-http', partition: 'client' },
      { target: 'sdk-auth-http', partition: 'transport' },
      { target: 'sdk-auth-http', partition: 'core' },
      { target: 'sdk-auth-http', partition: 'lookup' },
      { target: 'sdk-auth-http', partition: 'finite-http' },
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
  assert.deepEqual(
    parts.flatMap(part => part.target.mutate).sort(compareSpecifications),
    [...retained.mutate].sort(compareSpecifications)
  )
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
    packageDirectory:
      buildMutationTargets(REPOSITORY_ROOT)['root-eviction-records'].packageDirectory,
    testRunner: 'jest',
    runnerOptions: { jest: { config: { testMatch: ['all-original-root-tests'] } } },
    additionalInputs: ['src/root-eviction/**', 'all-original-fixtures'],
    mutate: [
      'src/root-eviction/RootEvictionRequests.ts',
      'src/root-eviction/RootEvictionServingRecords.ts',
      'src/root-eviction/FutureHelper.ts'
    ]
  }
  const parts = ['requests', 'serving'].map(id => ({
    id,
    target: selectedMutationPartition('root-eviction-records', root, id)
  }))
  assert.deepEqual(
    parts.map(part => part.id),
    ['requests', 'serving']
  )
  assert.deepEqual(
    parts.flatMap(part => part.target.mutate).sort(compareSpecifications),
    [...root.mutate].sort(compareSpecifications)
  )
  assert.deepEqual(parts[0].target.mutate, [root.mutate[0], root.mutate[2]])
  assert.deepEqual(parts[1].target.mutate, [root.mutate[1]])
  for (const part of parts) {
    assert.equal(part.target.runnerOptions, root.runnerOptions)
    assert.equal(part.target.additionalInputs, root.additionalInputs)
    assert.equal(part.target.testRunner, root.testRunner)
  }
  const execution = partitionMutationTarget('root-eviction-records', root)
  assert.deepEqual(
    execution.map(part => part.id),
    ['requests-1', 'requests-2', 'requests-3', 'remaining', 'serving-1', 'serving-2', 'serving-3']
  )
  assert.deepEqual(execution.find(part => part.id === 'remaining').target.mutate, [root.mutate[2]])
  assert.deepEqual(
    sourceLines(
      root,
      execution.flatMap(part => part.target.mutate).filter(file => file !== root.mutate[2])
    ),
    sourceLines(root, root.mutate.slice(0, 2))
  )
  for (const part of execution) assert.deepEqual({ ...part.target, mutate: root.mutate }, root)
  assert.equal(selectedMutationPartition('root-eviction-records', root), root)
  assert.throws(() => selectedMutationPartition('root-eviction-records', root, 'missing'))
  for (const specification of ['src/**/*.ts', '!src/Root.ts', '../outside.ts', '/outside.ts'])
    assert.throws(() =>
      partitionMutationTarget('root-eviction-records', { mutate: [specification] })
    )
  const targets = { 'root-eviction-records': root, other: { mutate: ['src/whole.ts'] } }
  assert.deepEqual(mutationExecutionMatrix(['other', 'root-eviction-records'], targets).include, [
    { target: 'other', partition: 'whole' },
    ...execution.map(part => ({ target: 'root-eviction-records', partition: part.id }))
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
      json: [
        'src/storage/actionRecovery/ActionRecoveryJSON.ts',
        'src/storage/actionRecovery/ActionRecoveryJSONOwnership.ts'
      ]
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
      journal: ['src/proposals/SQLiteProposalJournal.ts'],
      store: ['src/proposals/SQLiteProposalJournalStore.ts'],
      state: ['src/proposals/ProposalJournalState.ts'],
      domain: ['src/storage/SQLiteTransactionDomain.ts']
    }
  ]
])
  test(`${targetId} retains every complete file and original qualification input`, () => {
    const canonical = buildMutationTargets(REPOSITORY_ROOT)[targetId]
    const parts = Object.keys(expected).map(id => ({
      id,
      target: selectedMutationPartition(targetId, canonical, id)
    }))
    assert.deepEqual(Object.fromEntries(parts.map(part => [part.id, part.target.mutate])), expected)
    const union = parts.flatMap(part => part.target.mutate)
    assert.deepEqual(
      union.slice().sort(compareSpecifications),
      canonical.mutate.slice().sort(compareSpecifications)
    )
    assert.equal(new Set(union).size, union.length)
    for (const part of parts) {
      assert.deepEqual({ ...part.target, mutate: canonical.mutate }, canonical)
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
    ['store', 'scalar-codec', 'payload-codec']
  )
  assert.deepEqual(
    parts.flatMap(part => part.target.mutate).sort(compareSpecifications),
    [...canonical.mutate].sort(compareSpecifications)
  )
  for (const part of parts) {
    assert.deepEqual({ ...part.target, mutate: canonical.mutate }, canonical)
    assert.equal(part.target.runnerOptions, canonical.runnerOptions)
    assert.equal(part.target.additionalInputs, canonical.additionalInputs)
  }
  assert.deepEqual(parts[1].target.mutate, ['src/private/ProtectedLedgerCodec.ts'])
  assert.deepEqual(parts[2].target.mutate, [
    'src/private/NodeProtectedPayloadCodec.ts',
    'src/private/NativeOutputBytes.ts'
  ])
  const future = { ...canonical, mutate: [...canonical.mutate, 'src/private/FutureCompanion.ts'] }
  assert.ok(
    partitionMutationTarget('protected-ledger', future)
      .find(part => part.id === 'store')
      .target.mutate.includes('src/private/FutureCompanion.ts')
  )
})

test('private publication parts preserve every complete file and all canonical configuration', () => {
  const canonical = buildMutationTargets(REPOSITORY_ROOT)['private-publication-state']
  const parts = ['store', 'identity', 'records', 'progress'].map(id => ({
    id,
    target: selectedMutationPartition('private-publication-state', canonical, id)
  }))
  assert.deepEqual(
    parts.map(part => part.id),
    ['store', 'identity', 'records', 'progress']
  )
  assert.deepEqual(
    parts.flatMap(part => part.target.mutate).sort(compareSpecifications),
    [...canonical.mutate].sort(compareSpecifications)
  )
  for (const part of parts) {
    assert.deepEqual({ ...part.target, mutate: canonical.mutate }, canonical)
  }
  const future = { ...canonical, mutate: [...canonical.mutate, 'src/private/FutureCompanion.ts'] }
  assert.ok(
    selectedMutationPartition('private-publication-state', future, 'store').mutate.includes(
      'src/private/FutureCompanion.ts'
    )
  )
  const execution = partitionMutationTarget('private-publication-state', canonical)
  assert.deepEqual(
    execution.map(part => part.id),
    [
      'store-1',
      'store-2',
      'store-3',
      'store-4',
      'store-5',
      'identity',
      'records-1',
      'records-2',
      'progress-1',
      'progress-2',
      'progress-3',
      'progress-4',
      'progress-5'
    ]
  )
  assert.deepEqual(
    execution.find(part => part.id === 'identity'),
    parts.find(part => part.id === 'identity')
  )
  assert.deepEqual(
    partitionMutationTarget('private-publication-state', future).find(
      part => part.id === 'remaining'
    ).target.mutate,
    ['src/private/FutureCompanion.ts']
  )
  for (const part of execution)
    assert.deepEqual({ ...part.target, mutate: canonical.mutate }, canonical)
})

test('lineage graph parts retain complete layout and transition code and all canonical work', () => {
  const canonical = buildMutationTargets(REPOSITORY_ROOT)['revenue-lineage-graph']
  const parts = partitionMutationTarget('revenue-lineage-graph', canonical)
  assert.deepEqual(
    parts.map(part => part.id),
    ['layout', 'transition']
  )
  assert.deepEqual(
    parts.flatMap(part => part.target.mutate).sort(compareSpecifications),
    [...canonical.mutate].sort(compareSpecifications)
  )
  for (const part of parts) {
    assert.deepEqual({ ...part.target, mutate: canonical.mutate }, canonical)
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

test('verified publication service parts preserve every full module and canonical setting', () => {
  const canonical = buildMutationTargets(REPOSITORY_ROOT)['private-publication-service']
  const parts = ['evidence', 'contracts', 'original', 'binding', 'records'].map(id => ({
    id,
    target: selectedMutationPartition('private-publication-service', canonical, id)
  }))
  assert.deepEqual(
    parts.map(part => part.id),
    ['evidence', 'contracts', 'original', 'binding', 'records']
  )
  assert.deepEqual(
    parts.flatMap(part => part.target.mutate).sort(compareSpecifications),
    [...canonical.mutate].sort(compareSpecifications)
  )
  for (const part of parts) {
    assert.deepEqual({ ...part.target, mutate: canonical.mutate }, canonical)
  }
  const extended = { ...canonical, mutate: [...canonical.mutate, 'src/private/FutureCompanion.ts'] }
  assert.ok(
    partitionMutationTarget('private-publication-service', extended)
      .find(part => part.id === 'evidence')
      .target.mutate.includes('src/private/FutureCompanion.ts')
  )
  const execution = partitionMutationTarget('private-publication-service', canonical)
  assert.deepEqual(
    execution.map(part => part.id),
    ['evidence', 'contracts', 'original-1', 'original-2', 'binding-1', 'binding-2', 'records']
  )
  for (const id of ['evidence', 'contracts', 'records'])
    assert.deepEqual(
      execution.find(part => part.id === id),
      parts.find(part => part.id === id)
    )
  for (const part of execution)
    assert.deepEqual({ ...part.target, mutate: canonical.mutate }, canonical)
})

test('private publication coordination and HTTP partitions retain complete canonical inputs', () => {
  for (const id of ['private-publication-coordination', 'private-publication-http']) {
    const canonical = buildMutationTargets(REPOSITORY_ROOT)[id]
    const parts = partitionMutationTarget(id, canonical)
    if (id === 'private-publication-coordination') {
      assert.deepEqual(
        sourceLines(
          canonical,
          parts.flatMap(part => part.target.mutate)
        ),
        sourceLines(canonical, canonical.mutate)
      )
      const access = 'src/private/PrivatePublicationAccess.ts'
      const legacy = selectedMutationPartition(id, canonical, 'access')
      assert.deepEqual(legacy, { ...canonical, mutate: [access] })
      assert.equal(legacy.runnerOptions, canonical.runnerOptions)
      assert.equal(legacy.additionalInputs, canonical.additionalInputs)
      assert.ok(!parts.some(part => part.id === 'access'))
      assert.deepEqual(
        parts.filter(part => part.id.startsWith('access-')).map(part => part.id),
        ['access-1', 'access-2']
      )
      const untouched = parts.filter(part => !part.id.startsWith('access-'))
      assert.deepEqual(
        untouched.flatMap(part => part.target.mutate).sort(compareSpecifications),
        canonical.mutate.filter(file => file !== access).sort(compareSpecifications)
      )
      assert.equal(
        new Set(parts.flatMap(part => part.target.mutate)).size,
        parts.flatMap(part => part.target.mutate).length
      )
    } else {
      assert.deepEqual(
        parts.flatMap(part => part.target.mutate).sort(compareSpecifications),
        [...canonical.mutate].sort(compareSpecifications)
      )
      assert.equal(new Set(parts.flatMap(part => part.target.mutate)).size, canonical.mutate.length)
    }
    for (const part of parts) {
      assert.deepEqual({ ...part.target, mutate: canonical.mutate }, canonical)
    }
    const extended = {
      ...canonical,
      mutate: [...canonical.mutate, 'src/FuturePrivateCompanion.ts']
    }
    assert.equal(
      partitionMutationTarget(id, extended)
        .flatMap(part => part.target.mutate)
        .filter(path => path === 'src/FuturePrivateCompanion.ts').length,
      1
    )
  }
})

test('paid acquisition and proposal HTTP parts preserve exact whole-source/test unions', () => {
  for (const [id, expected] of [
    ['private-acquisition-foundation', ['progress', 'result', 'index', 'contracts', 'evidence']],
    ['private-acquisition-state', ['payloads', 'original', 'state', 'store']],
    ['private-acquisition-http', ['routes', 'policy', 'guard', 'host']],
    ['sdk-paid-lookup-http', ['transport', 'http']],
    ['protected-operation-state', ['wallet', 'state']],
    ['protected-operation-objects', ['plan', 'native', 'cipher', 'browser']],
    [
      'private-acquisition-coordination',
      ['access', 'ports', 'wallet', 'evidence', 'coordinator', 'disclosure', 'work', 'reconciler']
    ],
    ['overlay-proposal-http', ['routes', 'guard', 'policy']]
  ]) {
    const canonical = buildMutationTargets(REPOSITORY_ROOT)[id]
    const parts = partitionMutationTarget(id, canonical)
    assert.deepEqual(
      parts.map(part => part.id),
      expected
    )
    assert.deepEqual(
      parts.flatMap(part => part.target.mutate).sort(compareSpecifications),
      [...canonical.mutate].sort(compareSpecifications)
    )
    assert.equal(new Set(parts.flatMap(part => part.target.mutate)).size, canonical.mutate.length)
    for (const part of parts) {
      assert.deepEqual({ ...part.target, mutate: canonical.mutate }, canonical)
    }
  }
})

test('durable buyer parts retain the complete source union and identical native recovery tests', () => {
  const target = buildMutationTargets(REPOSITORY_ROOT)['private-lookup-buyer'],
    parts = partitionMutationTarget('private-lookup-buyer', target)
  assert.deepEqual(parts.map(part => part.id).sort(compareSpecifications), ['buyer', 'payment'])
  assert.deepEqual(
    parts.flatMap(part => part.target.mutate).sort(compareSpecifications),
    [...target.mutate].sort(compareSpecifications)
  )
  for (const part of parts) assert.equal(part.target.runnerOptions, target.runnerOptions)
  assert.deepEqual(parts.find(part => part.id === 'payment').target.mutate, [
    'src/private/WalletToolboxBuyerPayment.ts'
  ])
})

test('semantic anchors reject ambiguity, absent or duplicate methods and retain explicit numeric plans', () => {
  const lines = ['preamble', 'first() {', '}', '  second() {', '}', 'third() {']
  assert.deepEqual(
    semanticMutationStarts(lines, { markers: ['second() {', 'third() {'] }),
    [1, 4, 6]
  )
  const original = [1, 4]
  assert.equal(semanticMutationStarts(lines, { starts: original }), original)
  for (const plan of [
    {},
    { markers: [] },
    { markers: [null] },
    { markers: [''] },
    { markers: ['missing() {'] },
    { markers: ['}'] },
    { starts: [1], markers: ['second() {'] },
    { starts: null }
  ])
    assert.throws(() => semanticMutationStarts(lines, plan))
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
