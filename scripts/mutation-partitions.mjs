import { readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
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
        ['src/auth/Peer.ts', 'peer'],
        ['src/auth/clients/AuthFetch.ts', 'client'],
        ['src/auth/transports/SimplifiedFetchTransport.ts', 'transport'],
        ['src/auth/AuthMessageValidation.ts', 'message-validation'],
        ['src/overlay-tools/OutputLookupProtocol.ts', 'lookup'],
        ['src/overlay-tools/OutputLookupTransport.ts', 'lookup'],
        ['src/overlay-tools/internal/OutputFiniteHTTP.ts', 'finite-http']
      ]),
      lines: new Map([
        [
          'src/auth/AuthMessageValidation.ts',
          [
            ['core', null],
            ['core-snapshot', 'export function snapshotAuthMessage('],
            ['core-policy', '  const isGeneral =']
          ]
        ]
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
        ['src/private/NodeProtectedPayloadCodec.ts', 'payload-codec'],
        ['src/private/NativeOutputBytes.ts', 'payload-codec']
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
  ],
  [
    'brc52-envelope',
    {
      fallback: 'envelope-1',
      lines: new Map([
        [
          'src/brc52/envelope.ts',
          [
            ['envelope-1', null],
            ['envelope-2', 'function exactKeys('],
            ['envelope-3', 'function strictSignature('],
            ['envelope-4', 'function graph('],
            ['envelope-5', 'export function validateBRC52Disclosure('],
            ['envelope-6', 'export function parseBRC52Envelope(']
          ]
        ]
      ])
    }
  ],
  [
    'brc52-status',
    {
      fallback: 'status-1',
      lines: new Map([
        [
          'src/brc52/status.ts',
          [
            ['status-1', null],
            ['status-2', 'function snapshotObservation(']
          ]
        ]
      ])
    }
  ],
  [
    'brc52-disclosure',
    {
      fallback: 'disclosure-1',
      lines: new Map([
        [
          'src/brc52/disclosure.ts',
          [
            ['disclosure-1', null],
            ['disclosure-2', 'function validateReceipt(']
          ]
        ]
      ])
    }
  ],
  [
    'air-gap-codec',
    {
      fallback: 'support',
      files: new Map([['src/encoder.ts', 'encoder']]),
      lines: new Map([
        [
          'src/decoder.ts',
          [
            ['decoder-1', null],
            ['decoder-2', '  private enterSession(']
          ]
        ]
      ])
    }
  ],
  [
    'mandala-encoding',
    {
      fallback: 'mandala',
      files: new Map([
        ['src/strictCbor.ts', 'cbor'],
        ['src/Bsv21Binary.ts', 'bsv21']
      ])
    }
  ],
  [
    'webrtpay-frames',
    {
      fallback: 'frames-1',
      lines: new Map([
        [
          'src/channel/frames.ts',
          [
            ['frames-1', null],
            ['frames-2', 'class StructureCounts {']
          ]
        ]
      ])
    }
  ],
  [
    'webrtpay-codes',
    {
      fallback: 'codes',
      files: new Map([['src/codec/sdp.ts', 'sdp']])
    }
  ]
])

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
  const location = realpathSync(path.join(directory, file))
  if (!location.startsWith(`${realpathSync(ROOT)}${path.sep}`))
    throw new Error('Mutation partition source escapes repository')
  const source = readFileSync(location, 'utf8').split('\n')
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

function specificationLines(specification, lineCount) {
  const range = /:(\d+)(?:-(\d+))?$/.exec(specification)
  if (!range) return [1, lineCount]
  return [Number(range[1]), Number(range[2] ?? range[1])]
}

// A line plan cuts one file at explicit declaration markers. Each marker must
// start exactly one source line, so an edit that moves or duplicates it fails
// closed instead of silently shifting mutants between execution parts.
function lineSegments(target, file, cuts) {
  if (typeof target.packageDirectory !== 'string')
    throw new Error('Line-split mutation partition requires a package directory')
  const lines = readFileSync(path.resolve(ROOT, target.packageDirectory, file), 'utf8').split('\n')
  if (cuts.length < 2 || cuts[0][1] !== null)
    throw new Error('Line-split mutation partition must start at the first source line')
  const starts = cuts.map(([id, marker]) => {
    if (marker === null) return { id, line: 1 }
    const matches = lines.flatMap((line, index) => (line.startsWith(marker) ? [index + 1] : []))
    if (matches.length !== 1)
      throw new Error(`Mutation partition marker must start exactly one line in ${file}: ${marker}`)
    return { id, line: matches[0] }
  })
  for (let index = 1; index < starts.length; index += 1)
    if (starts[index].line <= starts[index - 1].line)
      throw new Error(`Mutation partition markers are out of order in ${file}`)
  return {
    lineCount: lines.length,
    segments: starts.map((start, index) => ({
      id: start.id,
      first: start.line,
      last: index + 1 < starts.length ? starts[index + 1].line - 1 : lines.length
    }))
  }
}

// Keep each file's complete original range union across its execution parts.
// File plans keep a whole file in one part; line plans intersect every original
// range with contiguous segments that cover the file. New canonical files join
// the target's fallback; a future helper cannot disappear.
// Targets without an explicit plan split by file automatically once they are
// slow. Mutant count does not predict time (tests dominate: 676 auth mutants
// take under two minutes while 358 envelope mutants took fifteen), so the
// estimate is the target's measured hosted seconds. A target never measured
// uses a deliberately pessimistic code-line estimate: an unneeded split costs
// one job's setup, a missed split holds the whole campaign.
const AUTO_PART_SECONDS = 180
const UNMEASURED_SECONDS_PER_CODE_LINE = 1
let measuredSeconds
function measuredTargetSeconds(targetId) {
  measuredSeconds ??= JSON.parse(
    readFileSync(path.join(ROOT, 'governance/mutation-testing/durations.json'), 'utf8')
  ).seconds
  const parts = Object.entries(measuredSeconds).filter(([key]) => key.startsWith(`${targetId}/`))
  return parts.length === 0 ? undefined : parts.reduce((sum, [, value]) => sum + value, 0)
}

const DECLARATION_MODIFIERS = new Set(['export', 'default', 'declare', 'async', 'abstract'])
const DECLARATION_KEYWORDS = new Set([
  'function',
  'function*',
  'class',
  'const',
  'let',
  'var',
  'interface',
  'type',
  'enum'
])

// A top-level declaration starts at column zero with optional modifiers.
function isTopLevelDeclaration(line) {
  if (/^\s/.test(line)) return false
  const words = line.split(/[\s(<{=:]+/)
  let index = 0
  while (DECLARATION_MODIFIERS.has(words[index])) index += 1
  return DECLARATION_KEYWORDS.has(words[index])
}

const MEMBER_MODIFIERS = new Set([
  'public',
  'private',
  'protected',
  'static',
  'readonly',
  'async',
  'override',
  'get',
  'set'
])

// A method, constructor or accessor at exactly the class body indent.
function isMemberDeclaration(line) {
  if (!/^ {2}\S/.test(line)) return false
  const words = line.trim().split(/ +/)
  let index = 0
  while (MEMBER_MODIFIERS.has(words[index])) index += 1
  return /^(?:\* ?)?[#A-Za-z_$][\w$]* ?[(<]/.test(words.slice(index).join(' '))
}

// Keywords after which `/` starts a regular expression rather than division.
const EXPRESSION_KEYWORDS = new Set([
  'abstract',
  'as',
  'async',
  'await',
  'case',
  'catch',
  'class',
  'const',
  'declare',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'for',
  'from',
  'function',
  'get',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'of',
  'override',
  'private',
  'protected',
  'public',
  'readonly',
  'return',
  'set',
  'static',
  'switch',
  'throw',
  'type',
  'typeof',
  'var',
  'void',
  'while',
  'yield'
])

function declarationKeyword(line) {
  return line.split(/[\s(<{=:]+/).find(word => !DECLARATION_MODIFIERS.has(word))
}

function scanState() {
  return {
    depth: 0,
    classDepth: 0,
    pendingClass: false,
    expectExpression: true,
    lineComment: false,
    modes: ['code'],
    interpolations: [],
    regexClass: false
  }
}

const currentMode = state => state.modes.at(-1)

function isClassBodyMember(state, line) {
  return (
    currentMode(state) === 'code' &&
    state.classDepth > 0 &&
    state.depth === state.classDepth &&
    isMemberDeclaration(line)
  )
}

// A block mutant covers its whole method, including a template that looks like
// another member, so a cut is safe only while the braces are still at the
// class body.
function classMemberLines(lines) {
  const members = new Set()
  const state = scanState()
  lines.forEach((line, index) => {
    if (isClassBodyMember(state, line)) members.add(index)
    scanLine(state, line)
  })
  return members
}

function scanLine(state, line) {
  if (currentMode(state) === 'code' && state.depth === 0 && isTopLevelDeclaration(line))
    state.pendingClass = declarationKeyword(line) === 'class'
  let index = 0
  while (index < line.length && !state.lineComment) index = scanAt(state, line, index) + 1
  state.lineComment = false
}

function scanAt(state, line, index) {
  const mode = currentMode(state)
  if (mode === 'block') return scanBlock(state, line, index)
  if (mode === 'single' || mode === 'double') return scanQuoted(state, line, index)
  if (mode === 'template') return scanTemplate(state, line, index)
  if (mode === 'regex') return scanRegex(state, line, index)
  return scanCode(state, line, index)
}

function scanCode(state, line, index) {
  const char = line[index]
  const next = line[index + 1]
  if (char === '/' && next === '/') {
    state.lineComment = true
    return index + 1
  }
  if (char === '/' && next === '*') {
    state.modes.push('block')
    return index + 1
  }
  if (char === '/' && state.expectExpression) {
    state.modes.push('regex')
    state.regexClass = false
    return index
  }
  if (char === '/') {
    state.expectExpression = true
    return index
  }
  if (char === "'" || char === '"') {
    pushQuote(state, char)
    return index
  }
  if (char === '`') {
    state.modes.push('template')
    return index
  }
  if (char === '{') return openBrace(state, index)
  if (char === '}') return closeBrace(state, index)
  if (/[A-Za-z_$]/.test(char)) return scanWord(state, line, index)
  if (/\d/.test(char)) return scanNumber(state, line, index)
  if (char === ' ' || char === '\t') return index
  return scanPunctuation(state, char, next, index)
}

function pushQuote(state, char) {
  state.modes.push(char === "'" ? 'single' : 'double')
}

function openBrace(state, index) {
  state.depth += 1
  if (state.pendingClass && state.depth === 1) {
    state.classDepth = state.depth
    state.pendingClass = false
  }
  state.expectExpression = true
  return index
}

function closeBrace(state, index) {
  const interpolation = state.interpolations.at(-1)
  if (interpolation !== undefined && state.depth === interpolation) {
    state.depth -= 1
    state.interpolations.pop()
    state.modes.pop()
    return index
  }
  state.depth -= 1
  if (state.classDepth > 0 && state.depth < state.classDepth) state.classDepth = 0
  state.expectExpression = false
  return index
}

function scanWord(state, line, index) {
  let end = index + 1
  while (end < line.length && /[A-Za-z0-9_$]/.test(line[end])) end += 1
  state.expectExpression = EXPRESSION_KEYWORDS.has(line.slice(index, end))
  return end - 1
}

function scanNumber(state, line, index) {
  let end = index + 1
  while (end < line.length && /[0-9A-Za-z_.]/.test(line[end])) end += 1
  state.expectExpression = false
  return end - 1
}

function scanPunctuation(state, char, next, index) {
  if ((char === '+' && next === '+') || (char === '-' && next === '-')) return index + 1
  if (char === '(' || char === '[') {
    state.expectExpression = true
    return index
  }
  if (char === ')' || char === ']') {
    state.expectExpression = false
    return index
  }
  if (char === '.') {
    state.expectExpression = false
    return index
  }
  if ('=+-*%&|^~!?:;,<>'.includes(char)) state.expectExpression = true
  return index
}

function scanBlock(state, line, index) {
  if (line[index] === '*' && line[index + 1] === '/') {
    state.modes.pop()
    return index + 1
  }
  return index
}

function scanQuoted(state, line, index) {
  const char = line[index]
  if (char === '\\') return Math.min(index + 1, line.length - 1)
  const quote = currentMode(state) === 'single' ? "'" : '"'
  if (char === quote) {
    state.modes.pop()
    state.expectExpression = false
  }
  return index
}

function scanTemplate(state, line, index) {
  const char = line[index]
  const next = line[index + 1]
  if (char === '\\') return Math.min(index + 1, line.length - 1)
  if (char === '`') {
    state.modes.pop()
    state.expectExpression = false
    return index
  }
  if (char === '$' && next === '{') {
    state.modes.push('code')
    state.depth += 1
    state.interpolations.push(state.depth)
    state.expectExpression = true
    return index + 1
  }
  return index
}

function scanRegex(state, line, index) {
  const char = line[index]
  if (char === '\\') return Math.min(index + 1, line.length - 1)
  if (char === '[' && !state.regexClass) {
    state.regexClass = true
    return index
  }
  if (char === ']' && state.regexClass) {
    state.regexClass = false
    return index
  }
  if (char === '/' && !state.regexClass) {
    state.modes.pop()
    state.expectExpression = false
  }
  return index
}

function isCode(line) {
  const text = line.trim()
  return text !== '' && !text.startsWith('//') && !text.startsWith('*') && !text.startsWith('/*')
}

// Per-line weight of a file: 1 for a code line inside any of the target's
// original ranges for that file, else 0.
function fileLineWeights(target, file, specifications) {
  const lines = readFileSync(path.resolve(ROOT, target.packageDirectory, file), 'utf8').split('\n')
  const weights = Array.from({ length: lines.length }, () => 0)
  for (const specification of specifications) {
    const [first, last] = specificationLines(specification, lines.length)
    for (let index = first - 1; index < Math.min(last, lines.length); index += 1)
      if (isCode(lines[index])) weights[index] = 1
  }
  return { lines, weights }
}

// Cut a file into `pieces` contiguous segments at top-level declaration or
// class member lines, balancing code weight. A mutant cannot span two
// top-level statements or two class members, and a cut line must be a unique
// line prefix so lineSegments can re-find it.
function fileSegments(lines, weights, pieces) {
  const before = [0]
  for (const weight of weights) before.push(before.at(-1) + weight)
  const total = before.at(-1)
  const members = classMemberLines(lines)
  const candidates = lines
    .map((line, index) => index)
    .filter(
      index =>
        index > 0 &&
        (isTopLevelDeclaration(lines[index]) || members.has(index)) &&
        lines.filter(other => other.startsWith(lines[index])).length === 1
    )
  // For each boundary pick the candidate whose preceding weight is nearest its
  // even share, keeping cuts strictly increasing.
  const starts = [0]
  for (let piece = 1; piece < pieces; piece += 1) {
    const goal = (total * piece) / pieces
    let best
    for (const index of candidates) {
      if (index <= starts.at(-1)) continue
      if (best === undefined || Math.abs(before[index] - goal) < Math.abs(before[best] - goal))
        best = index
    }
    if (best === undefined) break
    starts.push(best)
  }
  return starts
    .map((start, position) => {
      const end = position + 1 < starts.length ? starts[position + 1] : lines.length
      return { marker: position === 0 ? null : lines[start], weight: before[end] - before[start] }
    })
    .filter((segment, position) => position === 0 || segment.weight > 0)
}

function filesOf(target) {
  const byFile = new Map()
  for (const specification of target.mutate) {
    const file = partitionFile(specification)
    if (/[!*?{}[\]]/.test(file) || path.posix.isAbsolute(file) || file.split('/').includes('..'))
      return undefined
    byFile.set(file, [...(byFile.get(file) ?? []), specification])
  }
  return byFile
}

const sum = values => values.reduce((total, value) => total + value, 0)
const unitOrder = unit => `${unit.file}\u0000${String(unit.position).padStart(6, '0')}`

// Heaviest unit first into the lightest group; ties keep source order. Groups
// are then numbered by their first unit so the plan is stable.
function groupUnits(units, count) {
  const groups = Array.from({ length: count }, () => ({ weight: 0, units: [] }))
  const ordered = [...units].sort(
    (left, right) => right.weight - left.weight || unitOrder(left).localeCompare(unitOrder(right))
  )
  for (const unit of ordered) {
    const lightest = groups.reduce(
      (best, group) => (group.weight < best.weight ? group : best),
      groups[0]
    )
    lightest.units.push(unit)
    lightest.weight += unit.weight
  }
  for (const group of groups)
    group.units.sort((left, right) => unitOrder(left).localeCompare(unitOrder(right)))
  return groups.sort((left, right) =>
    unitOrder(left.units[0]).localeCompare(unitOrder(right.units[0]))
  )
}

function planFromGroups(files, units, groups) {
  const owner = new Map()
  groups.forEach((group, index) => {
    for (const unit of group.units) owner.set(`${unit.file}#${unit.position}`, `auto-${index + 1}`)
  })
  const plan = { fallback: 'auto-1', files: new Map(), lines: new Map() }
  for (const file of files) {
    const segments = units.filter(unit => unit.file === file)
    if (segments.length === 1) plan.files.set(file, owner.get(`${file}#0`))
    else
      plan.lines.set(
        file,
        segments.map(segment => [owner.get(`${file}#${segment.position}`), segment.marker])
      )
  }
  return plan
}

export function automaticPlan(targetId, target, measured = measuredTargetSeconds(targetId)) {
  if (typeof target.packageDirectory !== 'string') return undefined
  const byFile = filesOf(target)
  if (!byFile) return undefined
  const files = [...byFile].map(([file, specifications]) => ({
    file,
    ...fileLineWeights(target, file, specifications)
  }))
  const total = sum(files.map(entry => sum(entry.weights)))
  if (total === 0) return undefined
  const estimate = measured ?? total * UNMEASURED_SECONDS_PER_CODE_LINE
  // A file whose share of the estimate exceeds one part is cut inside.
  const units = files.flatMap(entry => {
    const share = (estimate * sum(entry.weights)) / total
    const pieces = Math.max(1, Math.ceil(share / AUTO_PART_SECONDS))
    return fileSegments(entry.lines, entry.weights, pieces).map((segment, position) => ({
      file: entry.file,
      position,
      ...segment
    }))
  })
  const count = Math.min(units.length, Math.ceil(estimate / AUTO_PART_SECONDS))
  if (count < 2) return undefined
  return planFromGroups(byFile.keys(), units, groupUnits(units, count))
}

export function partitionMutationTarget(targetId, target) {
  const ranges = rangePlans.get(targetId)
  if (ranges) return semanticPartitions(target, ranges, rangeCompanions.get(targetId))
  const plan = plans.get(targetId) ?? automaticPlan(targetId, target)
  if (!plan) return [{ id: 'whole', target }]
  const groups = new Map()
  const add = (id, specification) => {
    const mutate = groups.get(id) ?? []
    mutate.push(specification)
    groups.set(id, mutate)
  }
  const split = new Map()
  for (const specification of target.mutate) {
    const file = partitionFile(specification)
    if (/[!*?{}[\]]/.test(file) || path.posix.isAbsolute(file) || file.split('/').includes('..'))
      throw new Error('Mutation partition requires explicit canonical source paths')
    const cuts = plan.lines?.get(file)
    if (!cuts) {
      add(plan.files?.get(file) ?? plan.fallback, specification)
      continue
    }
    if (!split.has(file)) split.set(file, lineSegments(target, file, cuts))
    const { lineCount, segments } = split.get(file)
    const [first, last] = specificationLines(specification, lineCount)
    for (const segment of segments) {
      const from = Math.max(first, segment.first)
      const to = Math.min(last, segment.last)
      if (from <= to) add(segment.id, `${file}:${from}-${to}`)
    }
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
  if (
    !selected &&
    (refinedFileParts.get(targetId)?.has(partition) ||
      [...(plans.get(targetId)?.files.values() ?? [])].includes(partition))
  ) {
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

// Longest-processing-time-first scheduling: GitHub starts matrix jobs in listed
// order up to the concurrency limit, so list the slowest measured parts first
// and the short ones fill the remaining slots. Order only changes when a part
// starts, never which parts run. A part without a measurement (new or renamed)
// sorts first, so it can never be left as an unplanned tail.
export function longestFirst(matrix, seconds) {
  const cost = row => seconds[`${row.target}/${row.partition}`] ?? Number.MAX_SAFE_INTEGER
  return {
    include: matrix.include
      .map((row, index) => ({ row, index }))
      .sort((left, right) => cost(right.row) - cost(left.row) || left.index - right.index)
      .map(({ row }) => row)
  }
}
