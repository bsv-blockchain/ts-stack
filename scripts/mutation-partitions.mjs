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
        ['src/auth/transports/SimplifiedFetchTransport.ts', 'transport'],
        ['src/auth/AuthMessageValidation.ts', 'message-validation'],
        ['src/overlay-tools/OutputLookupProtocol.ts', 'lookup'],
        ['src/overlay-tools/OutputLookupTransport.ts', 'lookup'],
        ['src/overlay-tools/internal/OutputFiniteHTTP.ts', 'finite-http']
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
        ['src/private/ProtectedLedgerCodec.ts', 'scalar-codec'],
        ['src/private/NodeProtectedPayloadCodec.ts', 'payload-codec']
      ])
    }
  ],
  [
    'wallet-recovery-encoding',
    {
      fallback: 'binary',
      files: new Map([
        ['src/storage/actionRecovery/ActionRecoveryJSON.ts', 'json'],
        ['src/storage/actionRecovery/ActionRecoveryJSONOwnership.ts', 'json']
      ])
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
      'wallet-recovery-plan',
      [
        ['src/storage/actionRecovery/ActionRecoveryPlan.ts', { label: 'plan', starts: [1] }],
        [
          'src/storage/methods/createAction.ts',
          {
            label: 'construction',
            markers: ['async function recordCreateActionFailure(']
          }
        ]
      ]
    ],
    [
      'root-eviction-journal',
      [
        ['src/root-eviction/SQLiteRootEvictionStore.ts', { label: 'store', starts: [1, 275, 371] }],
        [
          'src/root-eviction/RootAdvertisementServing.ts',
          { label: 'advertisement', starts: [1, 136] }
        ],
        ['src/root-eviction/RootLookupServingDisclosure.ts', { label: 'disclosure', starts: [1] }]
      ]
    ],
    [
      'root-eviction-storage',
      [
        [
          'src/root-eviction/SQLiteRootEvictionDatabase.ts',
          { label: 'database', starts: [1, 134, 225, 305, 380] }
        ]
      ]
    ],
    [
      'overlay-private-publication-admission',
      [
        [
          'src/PrivatePublicationAdmission.ts',
          { label: 'publication', starts: [1, 172, 277, 344] }
        ],
        ['src/RetainedTopicAdmission.ts', { label: 'retained', starts: [1] }]
      ]
    ],
    [
      'lch-overlay-covenant-terms',
      [
        [
          'src/overlayAcquisitionCovenantTermsCore.ts',
          {
            label: 'terms',
            markers: [
              'function validateCovenantOfferMechanism(offer: SignedObject) {',
              'async function authenticateCovenantOffer<D extends LCHCovenantDescriptor, C>(',
              'async function authenticateCovenantConsent<D extends LCHCovenantDescriptor, C>(',
              'async function validateCovenantCapabilityAndPolicy<D extends LCHCovenantDescriptor, C>(',
              'export function validateLCHCovenantPromiseCore('
            ]
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
            markers: [
              'function digest(value: unknown): string {',
              'export function privatePurchaseOperation(original: PrivatePurchaseOriginal, txid: string): string {',
              'function response(progress: PrivatePurchaseProgress): OutputPurchaseEnvelope {',
              'function purchaseAdmission(',
              'function purchaseDelivery(',
              'function purchaseProgressReservation(',
              'function purchaseProgressPosition(',
              'function validatePurchaseProgressResult(',
              'export function parsePrivatePurchaseProgress(',
              'export function createPrivatePurchaseProgress(',
              'export function advancePrivatePurchaseProgress(',
              'export function privatePurchaseEnvelope('
            ]
          }
        ],
        [
          'src/private/SQLitePrivatePurchaseStore.ts',
          {
            label: 'store',
            markers: [
              'function encoded(input: unknown, maximum: number): string {',
              'function decoded(input: string, maximum: number): unknown {',
              'function authorize(guard: ProtectedLedgerGuard, view: ProtectedLedgerView): void {',
              'private readonly economicProfile?: PrivatePurchaseCandidateProfile',
              'private address(id: string) {',
              'private fence(id: string) {',
              'private custody(input: unknown): PrivatePurchaseCustody {',
              'private feasible(custody: PrivatePurchaseCustody): void {',
              'private payloadRows(payload: PrivateAcquisitionPayload, view: ProtectedLedgerView) {',
              'private restorePayloads(value: Record<string, unknown>, view: ProtectedLedgerView) {',
              'private requirePayloadReservations(',
              'private requireNativeRecord(',
              'private restore(',
              'load(',
              'prepare(',
              'private preparationPlan(input: PrivatePurchaseCustody, observedAt: string) {',
              'private require(',
              'pin(',
              'advance(',
              'complete(',
              'private commitPayload(',
              'private commit(',
              'disclose(',
              'discloseTerms(',
              'private enqueue<T>('
            ]
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
            markers: [
              'submit(input: unknown, supplied: PrivatePurchaseCaller): Promise<string> {',
              'private async admit(',
              'private async proofPlan(',
              'private current(caller: PrivatePurchaseCaller, signal: AbortSignal): boolean {'
            ]
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
            markers: [
              'static create(',
              'static open(',
              'private initialize(): void {',
              'private binding(kind: string, extra: OutputJSONObject): OutputJSONObject {',
              'private encode(binding: OutputJSONObject, text: string): string {',
              'private decode(binding: OutputJSONObject, envelope: string, maximum: number): ProtectedPlaintext {',
              'private envelopeBound(bytes: number): number {',
              'private saveHead(',
              'private head(): ProtectedLedgerHead {',
              'private headSnapshot(): ProtectedHeadSnapshot {',
              'private headers(): ProtectedLedgerHeader[] {',
              'private inventory(head: ProtectedLedgerHead): void {',
              'private record(address: ProtectedLedgerAddress): ProtectedLedgerRecord | undefined {',
              'private authorize(head: ProtectedLedgerHead, guard: ProtectedLedgerGuard): void {',
              'private synchronous(work: (...args: never[]) => unknown): void {',
              'private observed<T>(',
              'read(',
              'enumerate(',
              'private addresses(input: readonly ProtectedLedgerAddress[]): ProtectedLedgerAddress[] {',
              'private ownLocalBatch(',
              'private ownCommitOptions(input: ProtectedLedgerCommitOptions): ProtectedLedgerCommitOptions {',
              'commit(',
              'commitPrepared(',
              'private preparedGuard(guard: ProtectedLedgerGuard, view: ProtectedLedgerView): void {',
              'private ownChanges(',
              'private applyChanges(',
              'disclose(',
              'close(): void {'
            ]
          }
        ],
        [
          'src/private/SQLitePrivatePurchaseStore.ts',
          {
            label: 'store',
            markers: [
              'function encoded(input: unknown, maximum: number): string {',
              'function decoded(input: string, maximum: number): unknown {',
              'function authorize(guard: ProtectedLedgerGuard, view: ProtectedLedgerView): void {',
              'private readonly economicProfile?: PrivatePurchaseCandidateProfile',
              'private address(id: string) {',
              'private fence(id: string) {',
              'private custody(input: unknown): PrivatePurchaseCustody {',
              'private feasible(custody: PrivatePurchaseCustody): void {',
              'private payloadRows(payload: PrivateAcquisitionPayload, view: ProtectedLedgerView) {',
              'private restorePayloads(value: Record<string, unknown>, view: ProtectedLedgerView) {',
              'private requirePayloadReservations(',
              'private requireNativeRecord(',
              'private restore(',
              'load(',
              'prepare(',
              'private preparationPlan(input: PrivatePurchaseCustody, observedAt: string) {',
              'private require(',
              'pin(',
              'advance(',
              'complete(',
              'private commitPayload(',
              'private commit(',
              'disclose(',
              'discloseTerms(',
              'private enqueue<T>('
            ]
          }
        ],
        [
          'src/private/PrivatePurchaseProgress.ts',
          {
            label: 'progress',
            markers: [
              'function digest(value: unknown): string {',
              'export function privatePurchaseOperation(original: PrivatePurchaseOriginal, txid: string): string {',
              'function response(progress: PrivatePurchaseProgress): OutputPurchaseEnvelope {',
              'function purchaseAdmission(',
              'function purchaseDelivery(',
              'function purchaseProgressReservation(',
              'function purchaseProgressPosition(',
              'function validatePurchaseProgressResult(',
              'export function parsePrivatePurchaseProgress(',
              'export function createPrivatePurchaseProgress(',
              'export function advancePrivatePurchaseProgress(',
              'export function privatePurchaseEnvelope('
            ]
          }
        ]
      ]
    ],
    [
      'private-purchase-http',
      [
        [
          'src/PrivatePurchaseHTTPPolicy.ts',
          {
            label: 'policy',
            markers: [
              'export function sendPrivatePurchaseHTTPError(res: Response, error: unknown): void {',
              'export function privatePurchaseHTTPCORS('
            ]
          }
        ],
        ['src/PrivatePurchaseResponseGuard.ts', { label: 'guard', starts: [1] }],
        ['src/PrivateOverlayHost.ts', { label: 'host', starts: [1] }],
        [
          'src/PrivatePurchaseRoutes.ts',
          {
            label: 'routes',
            markers: [
              'class PrivatePurchaseHTTPHandler {',
              'private route(path: string): Route | undefined {',
              'readonly handle: RequestHandler = (req, res, next) => {',
              'private track(res: Response): void {',
              'private parsed(',
              'private acquire(identity: string): () => void {',
              'private async execute(',
              'export function createPrivatePurchaseRouter(options: PrivatePurchaseRouteOptions): Router {',
              'function authenticatedCaller('
            ]
          }
        ]
      ]
    ],
    [
      'wallet-recovery-store',
      [
        [
          'src/storage/actionRecovery/SQLiteActionRecoveryStore.ts',
          {
            label: 'store',
            markers: [
              'async lock(trx: TrxToken): Promise<Metadata> {',
              'async read(key: string, binding: string, trx?: TrxToken): Promise<Row | undefined> {',
              'async insert(row: Row, trx: TrxToken): Promise<void> {',
              'async replace(previous: Row, next: Row, trx: TrxToken): Promise<void> {',
              'private transaction(trx: TrxToken) {',
              'function validateRow(row: Row): void {',
              'function rowBytes(row: Row): number {',
              'function retained(row: Row): RetainedActionRecoveryPlan {'
            ]
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
            markers: [
              'async verify(',
              'private current(): void {',
              'private bindPrepared(',
              'private extend(',
              'private extendHistory(',
              'private bindTransaction(',
              'function purchaseFailure('
            ]
          }
        ]
      ]
    ]
  ].map(([id, files]) => [id, new Map(files)])
)

const refinedFileParts = new Map([
  [
    'wallet-recovery-encoding',
    new Map([
      [
        'json',
        new Map([
          ['src/storage/actionRecovery/ActionRecoveryJSON.ts', { label: 'json', starts: [1] }],
          [
            'src/storage/actionRecovery/ActionRecoveryJSONOwnership.ts',
            {
              label: 'ownership',
              markers: [
                'private array(input: unknown[], keys: (string | symbol)[], depth: number): JSONValue[] {',
                'private object(input: object, keys: (string | symbol)[], depth: number): { [key: string]: JSONValue } {'
              ]
            }
          ]
        ])
      ]
    ])
  ],
  [
    'root-eviction-records',
    new Map([
      [
        'requests',
        new Map([
          [
            'src/root-eviction/RootEvictionRequests.ts',
            { label: 'requests', starts: [1, 149, 188] }
          ]
        ])
      ],
      [
        'serving',
        new Map([
          [
            'src/root-eviction/RootEvictionServingRecords.ts',
            { label: 'serving', starts: [1, 93, 246] }
          ]
        ])
      ]
    ])
  ],
  [
    'private-publication-state',
    new Map([
      [
        'store',
        new Map([
          [
            'src/private/SQLitePrivatePublicationStore.ts',
            { label: 'store', starts: [1, 148, 262, 396, 521] }
          ]
        ])
      ],
      [
        'records',
        new Map([
          ['src/private/PrivatePublicationRecords.ts', { label: 'records', starts: [1, 150] }]
        ])
      ],
      [
        'progress',
        new Map([
          [
            'src/private/PrivatePublicationProgress.ts',
            { label: 'progress', starts: [1, 188, 242, 285, 380] }
          ]
        ])
      ]
    ])
  ],
  [
    'private-publication-service',
    new Map([
      [
        'original',
        new Map([
          [
            'src/private/PrivatePublicationContractRecord.ts',
            { label: 'original', starts: [1, 139] }
          ]
        ])
      ],
      [
        'binding',
        new Map([['src/private/PrivateLookupBinding.ts', { label: 'binding', starts: [1, 146] }]])
      ]
    ])
  ],
  [
    'private-publication-coordination',
    new Map([
      [
        'access',
        new Map([
          ['src/private/PrivatePublicationAccess.ts', { label: 'access', starts: [1, 124] }]
        ])
      ]
    ])
  ]
])

// Keep the complete presently type-only module in a nonempty execution part.
// Future executable content in that module remains part of the same full union.
const rangeCompanions = new Map([
  [
    'lch-overlay-covenant-terms',
    new Map([
      ['src/overlayAcquisitionCovenantTerms.ts', 'terms-1'],
      ['src/overlayAcquisitionCovenantProfileTerms.ts', 'terms-1']
    ])
  ],
  ['private-purchase-http', new Map([['src/PrivatePurchaseHTTPPorts.ts', 'routes-1']])],
  ['root-eviction-storage', new Map([['src/root-eviction/RootEvictionStorage.ts', 'database-1']])]
])

function specificationRange(specification, lines) {
  const match = /:(\d+)(?:-(\d+))?$/.exec(specification)
  const start = match ? Number(match[1]) : 1
  const end = match ? Number(match[2] ?? match[1]) : lines
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start)
    throw new Error('Invalid canonical mutation source range')
  return { start, end }
}

/** Resolve unique complete-method anchors; ambiguous configuration is rejected. */
export function semanticMutationStarts(lines, plan) {
  if (plan.starts !== undefined) {
    if (plan.markers !== undefined || !Array.isArray(plan.starts))
      throw new Error('Ambiguous semantic mutation partition boundaries')
    return plan.starts
  }
  if (!Array.isArray(plan.markers) || plan.markers.length === 0)
    throw new Error('Missing semantic mutation partition markers')
  return [
    1,
    ...plan.markers.map(marker => {
      if (typeof marker !== 'string' || marker.length === 0)
        throw new Error('Invalid semantic mutation partition marker')
      const matches = lines.flatMap((line, index) => (line.trim() === marker ? [index + 1] : []))
      if (matches.length !== 1)
        throw new Error(
          `Semantic mutation partition marker must identify one source line: ${marker}`
        )
      return matches[0]
    })
  ]
}

function rangeGroups(target, file, specifications, plan) {
  const directory = path.resolve(ROOT, target.packageDirectory)
  const location = fs.realpathSync(path.join(directory, file))
  if (!location.startsWith(`${fs.realpathSync(ROOT)}${path.sep}`))
    throw new Error('Mutation partition source escapes repository')
  const source = fs.readFileSync(location, 'utf8').split('\n')
  const lines = source.length
  const starts = semanticMutationStarts(source, plan)
  if (
    starts[0] !== 1 ||
    starts.some(
      (start, i) => !Number.isSafeInteger(start) || start < 1 || (i > 0 && start <= starts[i - 1])
    )
  )
    throw new Error('Invalid semantic mutation partition boundaries')
  return starts.flatMap((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] - 1 : lines
    const mutate = specifications.flatMap(specification => {
      const original = specificationRange(specification, lines)
      const low = Math.max(start, original.start),
        high = Math.min(end, original.end)
      return high < low ? [] : [`${file}:${low}-${high}`]
    })
    return mutate.length ? [{ id: `${plan.label}-${i + 1}`, target: { ...target, mutate } }] : []
  })
}

function appendCompanion(attachments, destination, specifications) {
  if (typeof destination !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(destination))
    throw new Error('Invalid mutation companion destination')
  const attached = attachments.get(destination) ?? []
  attached.push(...specifications)
  attachments.set(destination, attached)
}

function attachCompanions(parts, attachments) {
  for (const [destination, mutate] of attachments) {
    const part = parts.find(value => value.id === destination)
    if (!part) throw new Error('Mutation companion requires its nonempty source destination')
    part.target = { ...part.target, mutate: [...part.target.mutate, ...mutate] }
  }
}

function semanticPartitions(target, plan, companions) {
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
    future = [],
    attachments = new Map()
  for (const [file, specifications] of files) {
    const sourcePlan = plan.get(file),
      destination = companions?.get(file)
    if (sourcePlan && destination !== undefined)
      throw new Error('Mutation source has conflicting range and companion ownership')
    if (sourcePlan) parts.push(...rangeGroups(target, file, specifications, sourcePlan))
    else if (destination !== undefined) appendCompanion(attachments, destination, specifications)
    else future.push(...specifications)
  }
  attachCompanions(parts, attachments)
  if (future.length) parts.push({ id: 'remaining', target: { ...target, mutate: future } })
  if (!parts.length) throw new Error('Empty canonical mutation range union')
  return parts
}

// Existing file-based plans keep each original range union in one execution part.
// New canonical files join the target's fallback; a future helper cannot disappear.
export function partitionMutationTarget(targetId, target) {
  const ranges = rangePlans.get(targetId)
  if (ranges) return semanticPartitions(target, ranges, rangeCompanions.get(targetId))
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
