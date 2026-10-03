import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const partitionFile = specification => specification.replace(/:\d+(?:-\d+)?$/, '')
const plans = new Map([
  [
    'private-lookup-buyer',
    { fallback: 'buyer', files: new Map([['src/private/WalletToolboxBuyerPayment.ts', 'payment']]) }
  ],
  [
    'protected-operation-objects',
    {
      fallback: 'plan',
      files: new Map([
        ['src/operations/SQLiteProtectedOperationObjectStore.ts', 'native'],
        ['src/operations/ProtectedOperationObjectCipher.ts', 'cipher'],
        ['src/operations/IndexedDBProtectedOperationObjectStore.ts', 'browser']
      ])
    }
  ],
  [
    'sdk-paid-lookup-http',
    {
      fallback: 'transport',
      files: new Map([['src/overlay-tools/internal/OutputFiniteHTTP.ts', 'http']])
    }
  ],
  [
    'protected-operation-state',
    {
      fallback: 'wallet',
      files: new Map([['src/operations/ProtectedOperationStateStore.ts', 'state']])
    }
  ],
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
    'private-acquisition-http',
    {
      fallback: 'routes',
      files: new Map([
        ['src/PrivateAcquisitionHTTPPolicy.ts', 'policy'],
        ['src/PrivateAcquisitionResponseGuard.ts', 'guard'],
        ['src/PrivateOverlayHost.ts', 'host']
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
    'private-acquisition-coordination',
    {
      fallback: 'access',
      files: new Map([
        ['src/private/PrivateAcquisitionPorts.ts', 'ports'],
        ['src/private/PrivateAcquisitionWallet.ts', 'ports'],
        ['src/private/WalletToolboxAcquisitionFunding.ts', 'wallet'],
        ['src/private/SDKPrivateReleaseEvidence.ts', 'evidence'],
        ['src/private/PrivateAcquisitionCoordinator.ts', 'coordinator'],
        ['src/private/PrivateAcquisitionDisclosure.ts', 'disclosure'],
        ['src/private/PrivateAcquisitionWork.ts', 'work'],
        ['src/private/PrivateAcquisitionReconciler.ts', 'reconciler']
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

const ROOT = fileURLToPath(new URL('..', import.meta.url))
// Boundaries lie between complete functions or class members. Each part retains
// the original range union intersected with these consecutive source bands.
// The pinned-engine regression and final canonical gate reject lost or repeated
// mutants when future source changes move a mutable node across a boundary.
const rangePlans = new Map(
  [
    [
      'lch-overlay-covenant-terms',
      [
        [
          'src/overlayAcquisitionCovenantTerms.ts',
          {
            label: 'terms',
            starts: [1, 132, 167, 225, 288, 402]
          }
        ],
        [
          'src/overlayAcquisitionConsent.ts',
          {
            label: 'consent',
            starts: [1]
          }
        ]
      ]
    ],
    [
      'private-purchase-state',
      [
        [
          'src/private/PrivatePurchaseProgress.ts',
          {
            label: 'progress',
            starts: [1, 137, 155, 272, 297, 392]
          }
        ],
        [
          'src/private/SQLitePrivatePurchaseStore.ts',
          {
            label: 'store',
            starts: [1, 178, 271, 400, 604, 800]
          }
        ]
      ]
    ],
    [
      'private-purchase-coordination',
      [
        [
          'src/private/PrivatePurchaseCoordinator.ts',
          {
            label: 'coordinator',
            starts: [1, 226, 333, 538, 688]
          }
        ],
        [
          'src/private/PrivatePurchasePorts.ts',
          {
            label: 'ports',
            starts: [1]
          }
        ]
      ]
    ],
    [
      'private-purchase-native-clock',
      [
        [
          'src/private/SQLiteProtectedLedger.ts',
          {
            label: 'ledger',
            starts: [1, 203, 316, 410, 519, 633]
          }
        ],
        [
          'src/private/SQLitePrivatePurchaseStore.ts',
          {
            label: 'store',
            starts: [1, 178, 271, 400, 604, 800]
          }
        ],
        [
          'src/private/PrivatePurchaseProgress.ts',
          {
            label: 'progress',
            starts: [1, 137, 155, 272, 297, 392]
          }
        ]
      ]
    ],
    [
      'wallet-recovery-codec',
      [
        [
          'src/storage/actionRecovery/ActionRecoveryCodec.ts',
          { label: 'codec', starts: [1, 51, 102] }
        ]
      ]
    ],
    [
      'overlay-proposal-admission',
      [
        ['src/ProposalAdmission.ts', { label: 'proposal', starts: [1, 155, 229, 294] }],
        ['src/RetainedTopicAdmission.ts', { label: 'retained', starts: [1] }]
      ]
    ],
    [
      'revenue-listing-purchase',
      [
        [
          'src/revenue-listing/RevenueListingPurchaseVerifier.ts',
          {
            label: 'verifier',
            starts: [1, 160]
          }
        ]
      ]
    ]
  ].map(([id, files]) => [id, new Map(files)])
)

const refinedFileParts = new Map([
  [
    'private-publication-coordination',
    new Map([
      [
        'access',
        new Map([
          ['src/private/PrivatePublicationAccess.ts', { label: 'access', starts: [1, 125] }]
        ])
      ]
    ])
  ]
])

function specificationRange(specification, lines) {
  const match = /:(\d+)(?:-(\d+))?$/.exec(specification)
  const start = match ? Number(match[1]) : 1
  const end = match ? Number(match[2] ?? match[1]) : lines
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start)
    throw new Error('Invalid canonical mutation source range')
  return { start, end }
}

function rangeGroups(target, file, specifications, plan) {
  const directory = path.resolve(ROOT, target.packageDirectory)
  const location = fs.realpathSync(path.join(directory, file))
  if (!location.startsWith(`${fs.realpathSync(ROOT)}${path.sep}`))
    throw new Error('Mutation partition source escapes repository')
  const lines = fs.readFileSync(location, 'utf8').split('\n').length
  if (
    plan.starts[0] !== 1 ||
    plan.starts.some(
      (start, i) =>
        !Number.isSafeInteger(start) || start < 1 || (i > 0 && start <= plan.starts[i - 1])
    )
  )
    throw new Error('Invalid semantic mutation partition boundaries')
  return plan.starts.flatMap((start, i) => {
    const end = i + 1 < plan.starts.length ? plan.starts[i + 1] - 1 : lines
    const mutate = specifications.flatMap(specification => {
      const original = specificationRange(specification, lines)
      const low = Math.max(start, original.start),
        high = Math.min(end, original.end)
      return high < low ? [] : [`${file}:${low}-${high}`]
    })
    return mutate.length ? [{ id: `${plan.label}-${i + 1}`, target: { ...target, mutate } }] : []
  })
}

function semanticPartitions(target, plan) {
  const files = new Map()
  for (const specification of target.mutate) {
    const file = partitionFile(specification)
    if (/[!*?{}[\]]/.test(file) || path.posix.isAbsolute(file) || file.split('/').includes('..'))
      throw new Error('Mutation partition requires explicit canonical source paths')
    const specifications = files.get(file) ?? []
    specifications.push(specification)
    files.set(file, specifications)
  }
  if (!files.size) throw new Error('Empty canonical mutation source union')
  const parts = [],
    future = []
  for (const [file, specifications] of files) {
    const sourcePlan = plan.get(file)
    if (sourcePlan) parts.push(...rangeGroups(target, file, specifications, sourcePlan))
    else future.push(...specifications)
  }
  if (future.length) parts.push({ id: 'remaining', target: { ...target, mutate: future } })
  if (!parts.length) throw new Error('Empty canonical mutation range union')
  return parts
}

// Existing file-based plans keep each original range union in one execution part.
// New canonical files join the target's fallback; a future helper cannot disappear.
export function partitionMutationTarget(targetId, target) {
  const ranges = rangePlans.get(targetId)
  if (ranges) return semanticPartitions(target, ranges)
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
  const refinements = refinedFileParts.get(targetId)
  return [...groups].flatMap(([id, mutate]) => {
    const original = { id, target: { ...target, mutate } },
      refinement = refinements?.get(id)
    return refinement ? semanticPartitions(original.target, refinement) : [original]
  })
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
  // Keep an existing complete file-part CLI usable as a diagnostic alias. The
  // execution matrix and complete aggregate require every new refined part.
  if (!selected && refinedFileParts.get(targetId)?.has(partition)) {
    const plan = plans.get(targetId)
    const mutate = target.mutate.filter(
      specification => (plan.files.get(partitionFile(specification)) ?? plan.fallback) === partition
    )
    if (mutate.length) return { ...target, mutate }
  }
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
