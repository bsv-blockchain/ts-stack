import path from 'node:path'

const partitionFile = specification => specification.replace(/:\d+(?:-\d+)?$/, '')
const plans = new Map([
  [
    'private-publication-coordination',
    {
      fallback: 'leases',
      files: new Map([
        ['src/private/PrivatePublicationAccess.ts', 'access'],
        ['src/private/PrivatePublicationPorts.ts', 'ports'],
        ['src/private/PrivatePublicationCoordinator.ts', 'coordinator'],
        ['src/private/PrivatePublicationDisclosure.ts', 'disclosure'],
        ['src/private/PrivatePublicationWork.ts', 'work'],
        ['src/private/PrivatePublicationReconciler.ts', 'reconciler']
      ])
    }
  ],
  [
    'private-publication-http',
    {
      fallback: 'routes',
      files: new Map([
        ['src/PrivatePublicationHTTPPolicy.ts', 'policy'],
        ['src/PrivatePublicationResponseGuard.ts', 'guard']
      ])
    }
  ],

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
    'root-eviction-records',
    {
      fallback: 'requests',
      files: new Map([['src/root-eviction/RootEvictionServingRecords.ts', 'serving']])
    }
  ],
  [
    'output-knowledge-proposal-core',
    {
      fallback: 'worker',
      files: new Map([
        ['src/BitcoinKnowledgeState.ts', 'state'],
        ['src/KnowledgeStore.ts', 'store'],
        ['src/proposals/ProposalLocalState.ts', 'proposal'],
        ['src/proposals/ProposalKnowledgeView.ts', 'proposal']
      ])
    }
  ],
  [
    'proposal-journal-send',
    {
      fallback: 'journal',
      files: new Map([
        ['src/proposals/SQLiteProposalJournalStore.ts', 'store'],
        ['src/proposals/ProposalJournalState.ts', 'state'],
        ['src/storage/SQLiteTransactionDomain.ts', 'domain']
      ])
    }
  ],
  [
    'proposal-channel-storage',
    {
      fallback: 'factory',
      files: new Map([
        ['src/proposals/SQLiteProposalFeedWriter.ts', 'writer'],
        ['src/proposals/SQLiteProposalFeedInventory.ts', 'inventory'],
        ['src/proposals/ProposalChannelFeedCapacity.ts', 'capacity'],
        ['src/proposals/ProposalChannelFeedRecords.ts', 'records'],
        ['src/proposals/ProposalFeedPrivacy.ts', 'privacy'],
        ['src/proposals/AuthorDocumentPolicy.ts', 'policy']
      ])
    }
  ],
  [
    'overlay-proposal-http',
    {
      fallback: 'routes',
      files: new Map([
        ['src/ProposalResponseGuard.ts', 'guard'],
        ['src/ProposalHTTPPolicy.ts', 'policy'],
        ['src/ProposalHTTPPorts.ts', 'policy']
      ])
    }
  ],
  [
    'private-acquisition-state',
    {
      fallback: 'payloads',
      files: new Map([
        ['src/private/PrivateAcquisitionRecords.ts', 'original'],
        ['src/private/PrivateAcquisitionState.ts', 'state'],
        ['src/private/SQLitePrivateAcquisitionStore.ts', 'store']
      ])
    }
  ],
  [
    'private-acquisition-foundation',
    {
      fallback: 'progress',
      files: new Map([
        ['src/private/PrivateAcquisitionResult.ts', 'result'],
        ['src/private/PrivateAcquisitionFundingIndex.ts', 'index'],
        ['src/private/PrivateAcquisitionContracts.ts', 'contracts'],
        ['src/private/SDKPrivateAcquisitionFunding.ts', 'evidence']
      ])
    }
  ],
  [
    'private-publication-service',
    {
      fallback: 'evidence',
      files: new Map([
        ['src/private/PrivatePublicationContracts.ts', 'contracts'],
        ['src/private/PrivatePublicationContractRecord.ts', 'original'],
        ['src/private/PrivateLookupBinding.ts', 'binding'],
        ['src/private/PrivatePublicationServiceRecords.ts', 'records']
      ])
    }
  ],
  [
    'private-publication-state',
    {
      fallback: 'store',
      files: new Map([
        ['src/private/PrivateServiceIdentity.ts', 'identity'],
        ['src/private/PrivateServiceDomain.ts', 'identity'],
        ['src/private/PrivatePublicationRecords.ts', 'records'],
        ['src/private/PrivatePublicationProgress.ts', 'progress']
      ])
    }
  ],
  [
    'revenue-lineage-graph',
    {
      fallback: 'layout',
      files: new Map([['src/revenue-listing/LineageTransition.ts', 'transition']])
    }
  ],
  [
    'protected-ledger',
    {
      fallback: 'store',
      files: new Map([
        ['src/private/ProtectedLedgerCodec.ts', 'codec'],
        ['src/private/NodeProtectedPayloadCodec.ts', 'codec']
      ])
    }
  ],
  [
    'wallet-recovery-encoding',
    {
      fallback: 'binary',
      files: new Map([['src/storage/actionRecovery/ActionRecoveryJSON.ts', 'json']])
    }
  ],
  [
    'wallet-retained-snapshot',
    {
      fallback: 'lifecycle',
      files: new Map([
        ['src/storage/snapshot/KnexWalletReadSnapshot.ts', 'reader'],
        ['src/storage/StorageKnex.ts', 'storage'],
        ['src/storage/StorageProvider.ts', 'storage']
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
