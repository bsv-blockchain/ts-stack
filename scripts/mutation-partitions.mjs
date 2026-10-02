import path from 'node:path'

const partitionFile = specification => specification.replace(/:\d+(?:-\d+)?$/, '')
const plans = new Map([
  [
    'sdk-auth-http',
    {
      fallback: 'core',
      files: new Map([
        ['src/auth/clients/AuthFetch.ts', 'client'],
        ['src/auth/transports/SimplifiedFetchTransport.ts', 'transport']
      ])
    }
  ],
  [
    'wallet-retained-snapshot',
    {
      fallback: 'lifecycle',
      files: new Map([
        ['src/storage/snapshot/KnexWalletReadSnapshot.ts', 'reader'],
        ['src/storage/schema/snapshotProfileIndexMigration.ts', 'profile-index'],
        ['src/storage/schema/snapshotRelationIndexMigration.ts', 'relation-index'],
        ['src/storage/schema/snapshotCertificateIndexMigration.ts', 'certificate-index'],
        ['src/storage/schema/snapshotGlobalIndexMigration.ts', 'global-index'],
        ['src/storage/schema/snapshotGlobalIndexModel.ts', 'global-index'],
        ['src/storage/schema/snapshotGlobalIndexMysql.ts', 'global-mysql'],
        ['src/storage/schema/snapshotGlobalIndexSqlite.ts', 'global-sqlite'],
        ['src/storage/schema/snapshotGlobalIndexBootstrap.ts', 'global-bootstrap'],
        ['src/storage/schema/snapshotGlobalIndexTriggers.ts', 'global-triggers'],
        ['src/storage/StorageKnex.ts', 'storage'],
        ['src/storage/StorageProvider.ts', 'storage']
      ])
    }
  ],
  [
    'wallet-snapshot-archive',
    {
      fallback: 'capture',
      files: new Map([
        ['src/storage/snapshot/archive/KnexSnapshotArchiveStore.ts', 'store'],
        ['src/storage/schema/snapshotArchiveMigration.ts', 'store'],
        ['src/storage/snapshot/archive/KnexSnapshotArchiveSource.ts', 'source'],
        ['src/storage/snapshot/archive/KnexSnapshotArchiveClosure.ts', 'source']
      ])
    }
  ],
  [
    'wallet-snapshot-remote-http',
    {
      fallback: 'protocol',
      files: new Map([
        ['src/storage/remoting/StorageServer.ts', 'server'],
        ['src/storage/remoting/StorageClientBase.ts', 'client']
      ])
    }
  ],
  [
    'wallet-snapshot-remote-service',
    {
      fallback: 'persistence',
      files: new Map([
        ['src/storage/snapshot/archive/KnexSnapshotArchiveService.ts', 'controller'],
        ['src/storage/snapshot/archive/SnapshotArchiveGuard.ts', 'guard'],
        ['src/storage/snapshot/archive/SnapshotArchiveGuardRegistry.ts', 'guard'],
        ['src/storage/snapshot/archive/SnapshotArchiveGuardBackend.ts', 'backend']
      ])
    }
  ],
  [
    'wallet-snapshot-remote-reader',
    {
      fallback: 'admission',
      files: new Map([
        ['src/storage/snapshot/archive/RemoteSnapshotLease.ts', 'lease'],
        ['src/storage/snapshot/archive/RemoteSnapshotRows.ts', 'rows'],
        ['src/storage/snapshot/archive/RemoteSnapshotPageReader.ts', 'page'],
        ['src/storage/snapshot/archive/openRemoteSnapshot.ts', 'page'],
        ['src/storage/snapshot/SnapshotCursor.ts', 'page']
      ])
    }
  ]
])

// Keep each file's complete original range union in exactly one execution part.
// New canonical files join the target's fallback; a future helper cannot disappear.
export function partitionMutationTarget(targetId, target) {
  const plan = plans.get(targetId)
  if (!plan) return [{ id: 'whole', target }]
  const groups = new Map()
  for (const specification of target.mutate) {
    const file = partitionFile(specification)
    if (/[!*?{}[\]]/.test(file) || path.posix.isAbsolute(file) || file.split('/').includes('..'))
      throw new Error('Mutation partition requires explicit canonical source paths')
    const id = plan.files.get(file) ?? plan.fallback
    const mutate = groups.get(id) ?? []
    mutate.push(specification)
    groups.set(id, mutate)
  }
  if (groups.size === 0) throw new Error('Empty canonical mutation source union')
  return [...groups].map(([id, mutate]) => ({ id, target: { ...target, mutate } }))
}

export function partitionedMutationTargets(selected, targets) {
  return [
    ...new Set(
      mutationExecutionMatrix(selected, targets)
        .include.filter(value => value.partition !== 'whole')
        .map(value => value.target)
    )
  ]
}

export function selectedMutationPartition(targetId, target, partition = 'whole') {
  if (partition === 'whole') return target
  const selected = partitionMutationTarget(targetId, target).find(value => value.id === partition)
  if (!selected) throw new Error(`Unknown mutation execution partition ${targetId}/${partition}`)
  return selected.target
}

export function mutationExecutionMatrix(selected, targets) {
  if (!Array.isArray(selected) || new Set(selected).size !== selected.length)
    throw new Error('Missing or duplicate canonical target selection')
  return {
    include: selected.flatMap(targetId => {
      if (!Object.hasOwn(targets, targetId)) throw new Error('Unknown canonical mutation target')
      return partitionMutationTarget(targetId, targets[targetId]).map(({ id }) => ({
        target: targetId,
        partition: id
      }))
    })
  }
}
