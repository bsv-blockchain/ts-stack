import fs, { readFileSync, realpathSync } from 'node:fs'

import path from 'node:path'

import { createHash } from 'node:crypto'

import { fileURLToPath } from 'node:url'

import { isDeepStrictEqual } from 'node:util'

import { buildMutationTargets } from '../governance/mutation-testing/targets.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const executionPlanPath = 'governance/mutation-testing/execution-partitions.json'

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
    'wallet-portable-canonical-chunks',
    {
      fallback: 'helpers',
      files: new Map([
        ['src/storage/portable/CanonicalPortableBounds.ts', 'bounds'],
        ['src/storage/portable/CanonicalPortableValue.ts', 'value'],
        ['src/storage/portable/CanonicalPortableParts.ts', 'parts'],
        ['src/storage/portable/CanonicalPortableChunks.ts', 'writer']
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
    'wallet-snapshot-sync',
    {
      fallback: 'session',
      files: new Map([
        ['src/utility/runInSeries.ts', 'session'],
        ['src/storage/sync/syncSession.ts', 'session'],
        ['src/storage/snapshot/SnapshotSync.ts', 'session'],
        ['src/storage/sync/syncCheckpoint.ts', 'checkpoint'],
        ['src/storage/snapshot/runSnapshotSyncSession.ts', 'copy'],
        ['src/storage/StorageKnex.ts', 'storage'],
        ['src/storage/WalletStorageManager.ts', 'primary']
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
        ['src/storage/schema/snapshotSqliteSchemaObservations.ts', 'global-sqlite'],
        ['src/storage/schema/snapshotGlobalIndexBootstrap.ts', 'global-bootstrap'],
        ['src/storage/schema/snapshotGlobalIndexTriggers.ts', 'global-triggers'],
        ['src/storage/schema/snapshotSqliteIdentity.ts', 'sqlite-identity'],
        ['src/storage/schema/snapshotSqliteIdentityObservations.ts', 'sqlite-identity'],
        ['src/storage/schema/snapshotSqliteMembership.ts', 'sqlite-membership'],
        ['src/storage/schema/snapshotSqliteIndexGeneration.ts', 'sqlite-generation'],
        ['src/storage/schema/snapshotSqliteIndexBootstrap.ts', 'sqlite-bootstrap'],
        ['src/storage/schema/snapshotSqliteIndexState.ts', 'sqlite-bootstrap'],
        ['src/storage/schema/snapshotSqliteIndexRetirement.ts', 'sqlite-retirement'],
        ['src/storage/schema/snapshotSqliteLegacyOwnership.ts', 'sqlite-generation'],
        ['src/storage/schema/snapshotSqliteIndexMigration.ts', 'sqlite-retirement'],
        ['src/storage/StorageKnex.ts', 'storage'],
        ['src/storage/StorageProvider.ts', 'storage']
      ])
    }
  ],
  [
    'wallet-snapshot-journal',
    {
      fallback: 'revision',
      files: new Map([
        ['src/storage/snapshot/journal/SnapshotJournalRevision.ts', 'revision'],
        ['src/storage/snapshot/journal/SnapshotJournalRevisionSql.ts', 'revision'],
        ['src/storage/snapshot/journal/SnapshotJournalPage.ts', 'page'],
        ['src/storage/snapshot/journal/SnapshotJournalSqliteClock.ts', 'clock'],
        ['src/storage/snapshot/journal/SnapshotJournalMysqlClock.ts', 'clock'],
        ['src/storage/snapshot/journal/SnapshotJournalSqliteObservers.ts', 'sqlite-observers'],
        ['src/storage/snapshot/journal/SnapshotJournalMysqlObservers.ts', 'mysql-observers'],
        ['src/storage/snapshot/journal/SnapshotJournalBootstrap.ts', 'bootstrap'],
        ['src/storage/snapshot/journal/SnapshotJournalHighWater.ts', 'high-water'],
        ['src/storage/snapshot/journal/SnapshotJournalMysqlSource.ts', 'mysql-source'],
        ['src/storage/snapshot/journal/SnapshotJournalSqliteGeneration.ts', 'sqlite-generation'],
        ['src/storage/snapshot/journal/SnapshotJournalMysqlIntent.ts', 'mysql-intent'],
        ['src/storage/snapshot/journal/SnapshotJournalMysqlGeneration.ts', 'mysql-generation'],
        ['src/storage/snapshot/journal/SnapshotJournalReceipt.ts', 'receipts'],
        ['src/storage/snapshot/journal/SnapshotJournalCaptureFence.ts', 'capture-fence'],
        ['src/storage/snapshot/journal/SnapshotJournalConnections.ts', 'connections'],
        ['src/storage/snapshot/journal/SnapshotJournalCaptureBackend.ts', 'capture-backend'],
        ['src/storage/snapshot/journal/SnapshotJournalCapture.ts', 'capture'],
        ['src/storage/snapshot/journal/SnapshotJournalCollection.ts', 'collection'],
        ['src/storage/snapshot/journal/SnapshotJournalMaintenance.ts', 'maintenance'],
        ['src/storage/snapshot/journal/SnapshotJournalMaintenanceFence.ts', 'maintenance-fence'],
        ['src/storage/snapshot/journal/SnapshotJournalMaintenanceTask.ts', 'maintenance-task']
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

const upstreamPlans = new Map([
  [
    'sdk-auth-http',
    {
      fallback: 'core',
      files: new Map([
        ['src/auth/Peer.ts', 'peer'],
        ['src/auth/clients/AuthFetch.ts', 'client'],
        ['src/auth/transports/SimplifiedFetchTransport.ts', 'transport']
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

function specificationLines(specification, lineCount) {
  const range = /:(\d+)(?:-(\d+))?$/.exec(specification)
  if (!range) return [1, lineCount]
  return [Number(range[1]), Number(range[2] ?? range[1])]
}

function lineSegments(target, file, cuts) {
  if (typeof target.packageDirectory !== 'string')
    throw new Error('Line-split mutation partition requires a package directory')
  const lines = fs
    .readFileSync(path.resolve(ROOT, target.packageDirectory, file), 'utf8')
    .split('\n')
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

const AUTO_PART_SECONDS = 180

const UNMEASURED_SECONDS_PER_CODE_LINE = 1

let measuredSeconds

function measuredTargetSeconds(targetId) {
  measuredSeconds ??= JSON.parse(
    fs.readFileSync(path.join(ROOT, 'governance/mutation-testing/durations.json'), 'utf8')
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

function isMemberDeclaration(line) {
  if (!/^ {2}\S/.test(line)) return false
  const words = line.trim().split(/ +/)
  let index = 0
  while (MEMBER_MODIFIERS.has(words[index])) index += 1
  return /^(?:\* ?)?[#A-Za-z_$][\w$]* ?[(<]/.test(words.slice(index).join(' '))
}

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

function fileLineWeights(target, file, specifications) {
  const lines = fs
    .readFileSync(path.resolve(ROOT, target.packageDirectory, file), 'utf8')
    .split('\n')
  const weights = Array.from({ length: lines.length }, () => 0)
  for (const specification of specifications) {
    const [first, last] = specificationLines(specification, lines.length)
    for (let index = first - 1; index < Math.min(last, lines.length); index += 1)
      if (isCode(lines[index])) weights[index] = 1
  }
  return { lines, weights }
}

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
  return groups
    .filter(group => group.units.length !== 0)
    .sort((left, right) => unitOrder(left.units[0]).localeCompare(unitOrder(right.units[0])))
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

const executionCompanions = new Map([
  ['private-purchase-disclosure', ['auto-2', 'auto-3']],
  ['root-eviction-coordination', ['auto-2', 'auto-1']],
  ['private-purchase-buyer', ['auto-8', 'auto-1']]
])

function withExecutionCompanions(targetId, parts) {
  const companion = executionCompanions.get(targetId)
  if (!companion) return parts
  const [from, into] = companion
  if (!parts.some(part => part.id === from) || !parts.some(part => part.id === into))
    throw new Error(`Missing canonical execution companion ${targetId}`)
  const mutate = parts
    .filter(part => part.id === from || part.id === into)
    .flatMap(part => part.target.mutate)
  return parts
    .filter(part => part.id !== from)
    .map(part => (part.id === into ? { ...part, target: { ...part.target, mutate } } : part))
}

export function canonicalMutationPartitions(targetId, target, scheduled = true) {
  const plan = plans.get(targetId) ?? (scheduled ? scheduledPlan(targetId, target) : undefined)
  if (!plan) return [{ id: 'whole', target }]
  return partitionsWithPlan(target, plan)
}

function partitionsWithPlan(target, plan) {
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
  return [...groups].map(([id, mutate]) => ({ id, target: { ...target, mutate } }))
}

function sourceSpecification(specification) {
  if (typeof specification !== 'string') throw new Error('Invalid execution source specification')
  const match = /^(.*?)(?::([1-9]\d*)(?:-([1-9]\d*))?)?$/.exec(specification)
  const file = match?.[1]
  if (
    !file ||
    file.includes('\\') ||
    /[!*?{}[\]:]/.test(file) ||
    path.posix.isAbsolute(file) ||
    file.split('/').includes('..')
  )
    throw new Error('Execution refinements require explicit canonical source paths')
  const start = match[2] === undefined ? 1 : Number(match[2])
  const end = match[2] === undefined ? Infinity : Number(match[3] ?? match[2])
  if (
    !Number.isSafeInteger(start) ||
    start < 1 ||
    (end !== Infinity && !Number.isSafeInteger(end)) ||
    end < start
  )
    throw new Error('Invalid execution source range')
  return { file, start, end }
}

export function refineMutationPartition(base, unit, readSource) {
  if (
    unit.packageDirectory !== base.target.packageDirectory ||
    !Array.isArray(unit.originalMutate) ||
    !unit.sourceHashes ||
    typeof unit.sourceHashes !== 'object' ||
    Array.isArray(unit.sourceHashes) ||
    !Array.isArray(unit.parts) ||
    unit.parts.length === 0 ||
    !Number.isSafeInteger(unit.canonicalCount) ||
    unit.canonicalCount < 1
  )
    throw new Error('Invalid source-bound execution refinement')
  const known = new Set(
    unit.originalMutate.map(specification => sourceSpecification(specification).file)
  )
  if (
    !isDeepStrictEqual(
      [...known].sort((left, right) => left.localeCompare(right)),
      Object.keys(unit.sourceHashes).sort((left, right) => left.localeCompare(right))
    )
  )
    throw new Error('Execution source hash inventory differs from original specifications')
  const actual = base.target.mutate.map(specification => ({
    specification,
    ...sourceSpecification(specification)
  }))
  if (
    !isDeepStrictEqual(
      actual.filter(value => known.has(value.file)).map(value => value.specification),
      unit.originalMutate
    )
  )
    throw new Error(
      'Canonical execution specifications changed; regenerate the reviewed execution plan'
    )
  const lines = new Map()
  for (const file of known) {
    const bytes = readSource(file),
      expected = unit.sourceHashes[file]
    if (
      typeof expected !== 'string' ||
      !/^[a-f0-9]{64}$/.test(expected) ||
      createHash('sha256').update(bytes).digest('hex') !== expected
    )
      throw new Error(`Execution source changed: ${file}; regenerate the reviewed execution plan`)
    lines.set(file, bytes.toString('utf8').split('\n').length)
  }
  const owners = new Map(),
    ids = new Set(),
    covered = new Set()
  let count = 0
  const parts = unit.parts.map(part => {
    if (
      typeof part.id !== 'string' ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(part.id) ||
      part.id === 'whole' ||
      ids.has(part.id) ||
      !Array.isArray(part.mutate) ||
      part.mutate.length === 0 ||
      !Number.isSafeInteger(part.count) ||
      part.count < 1
    )
      throw new Error('Missing or duplicate execution refinement identity')
    ids.add(part.id)
    count += part.count
    for (const specification of part.mutate) {
      const { file, start, end } = sourceSpecification(specification)
      if (
        !known.has(file) ||
        start > lines.get(file) ||
        (end !== Infinity && end > lines.get(file))
      )
        throw new Error('Execution range lies outside its complete canonical source')
      const previous = owners.get(file) ?? []
      if (previous.some(value => value.id !== part.id && start <= value.end && value.start <= end))
        throw new Error('Execution source ranges overlap across partitions')
      previous.push({ start, end, id: part.id })
      owners.set(file, previous)
      covered.add(file)
    }
    return { id: part.id, target: { ...base.target, mutate: [...part.mutate] } }
  })
  if (count !== unit.canonicalCount || covered.size !== known.size)
    throw new Error('Execution refinement omits canonical source or mutant inventory')
  // Future canonical helpers remain owned in full; they cannot silently vanish.
  parts[0].target.mutate.push(
    ...actual.filter(value => !known.has(value.file)).map(value => value.specification)
  )
  return parts
}

export function applyPartitionComponentTests(base, selection, readSource) {
  const target = base.target
  if (
    !selection ||
    typeof selection !== 'object' ||
    !isDeepStrictEqual(selection.mutate, target.mutate) ||
    !selection.sourceHashes ||
    typeof selection.sourceHashes !== 'object' ||
    Array.isArray(selection.sourceHashes) ||
    !Array.isArray(selection.tests) ||
    selection.tests.length === 0 ||
    new Set(selection.tests).size !== selection.tests.length
  )
    throw new Error('Invalid source-bound component selection')
  const files = [...new Set(target.mutate.map(value => sourceSpecification(value).file))].sort(
    (left, right) => left.localeCompare(right)
  )
  if (
    !isDeepStrictEqual(
      files,
      Object.keys(selection.sourceHashes).sort((left, right) => left.localeCompare(right))
    )
  )
    throw new Error('Component source inventory differs')
  for (const file of files) {
    const expected = selection.sourceHashes[file]
    if (
      typeof expected !== 'string' ||
      !/^[a-f0-9]{64}$/.test(expected) ||
      createHash('sha256').update(readSource(file)).digest('hex') !== expected
    )
      throw new Error('Component source changed; review its selection and coverage')
  }
  const config = target.runnerOptions?.jest?.config
  const property = target.propertyTest?.slice(target.packageDirectory.length + 1)
  if (
    !config ||
    !Array.isArray(config.testMatch) ||
    !selection.tests.includes(property) ||
    selection.tests.some(
      file =>
        typeof file !== 'string' ||
        file.includes('\\') ||
        path.posix.isAbsolute(file) ||
        /[!*?{}[\]:]/.test(file) ||
        file.split('/').some(part => part === '.' || part === '..') ||
        target.requiredFunctionalTests?.includes(file) ||
        !config.testMatch.some(pattern => path.matchesGlob('<rootDir>/' + file, pattern))
    )
  )
    throw new Error('Component tests omit a property or escape the original universe')
  return {
    ...base,
    target: {
      ...target,
      runnerOptions: {
        ...target.runnerOptions,
        jest: {
          ...target.runnerOptions.jest,
          config: {
            ...config,
            testMatch: selection.tests.map(file => '<rootDir>/' + file)
          }
        }
      }
    }
  }
}

function executionPartitions(targetId, target, scheduled) {
  const original = canonicalMutationPartitions(targetId, target, scheduled)
  const selections = target.componentTestPartitions ?? {}
  if (
    typeof selections !== 'object' ||
    Array.isArray(selections) ||
    Object.keys(selections).some(id => !original.some(part => part.id === id))
  )
    throw new Error('Unknown component execution partition')
  const base = original.map(part =>
    selections[part.id] === undefined
      ? part
      : applyPartitionComponentTests(part, selections[part.id], file =>
          fs.readFileSync(path.join(ROOT, target.packageDirectory, file))
        )
  )
  const plan = JSON.parse(fs.readFileSync(path.join(ROOT, executionPlanPath), 'utf8'))
  if (plan.schemaVersion !== 1 || plan.engine !== '9.6.1' || !Array.isArray(plan.units))
    throw new Error('Missing reviewed execution refinement manifest')
  const units = plan.units.filter(unit => unit.target === targetId)
  const identities = new Set(units.map(unit => unit.existingPartition))
  if (
    identities.size !== units.length ||
    units.some(unit => !base.some(part => part.id === unit.existingPartition))
  )
    throw new Error('Unknown or duplicate original execution partition')
  const parts = base.flatMap(part => {
    const unit = units.find(value => value.existingPartition === part.id)
    return unit === undefined
      ? [part]
      : refineMutationPartition(part, unit, file =>
          fs.readFileSync(path.join(ROOT, target.packageDirectory, file))
        )
  })
  if (new Set(parts.map(part => part.id)).size !== parts.length)
    throw new Error('Execution refinement identities collide')
  return parts
}

export function admitSchedulingPlans(baseRows, candidates, ceiling = 256) {
  if (!Number.isSafeInteger(baseRows) || baseRows < 0 || baseRows > ceiling)
    throw new Error('Required mutation execution topology exceeds the matrix ceiling')
  const admitted = new Map()
  let rows = baseRows
  const seen = new Set()
  for (const { targetId, plan, parts } of candidates) {
    if (!Number.isSafeInteger(parts) || parts < 1 || seen.has(targetId))
      throw new Error('Invalid optional mutation scheduling candidate')
    seen.add(targetId)
    if (rows + parts - 1 > ceiling) continue
    admitted.set(targetId, plan)
    rows += parts - 1
  }
  return admitted
}

export function schedulingTopology(targets, units) {
  if (!Array.isArray(units)) throw new Error('Missing reviewed scheduling units')
  const required = new Map(
    Object.entries(targets).map(([id, target]) => [
      id,
      canonicalMutationPartitions(id, target, false)
    ])
  )
  let rows = [...required.values()].reduce((count, parts) => count + parts.length, 0)
  const protectedTargets = new Set()
  const seen = new Set()
  for (const unit of units) {
    const key = `${unit.target}/${unit.existingPartition}`
    if (
      seen.has(key) ||
      !required.get(unit.target)?.some(part => part.id === unit.existingPartition) ||
      !Array.isArray(unit.parts) ||
      unit.parts.length === 0
    )
      throw new Error('Unknown or duplicate required scheduling unit')
    seen.add(key)
    protectedTargets.add(unit.target)
    rows += unit.parts.length - 1
  }
  const candidates = []
  for (const [id, target] of Object.entries(targets)) {
    if (plans.has(id) || protectedTargets.has(id)) continue
    const plan = upstreamPlans.get(id) ?? automaticPlan(id, target)
    if (!plan) continue
    candidates.push({ targetId: id, plan, parts: partitionsWithPlan(target, plan).length })
  }
  const admitted = admitSchedulingPlans(rows, candidates, Number.MAX_SAFE_INTEGER)
  return {
    admitted,
    executionRows:
      rows +
      candidates.reduce(
        (extra, candidate) => extra + (admitted.has(candidate.targetId) ? candidate.parts - 1 : 0),
        0
      )
  }
}

let registryScheduling

function scheduledPlan(targetId, target) {
  if (registryScheduling === undefined) {
    const targets = buildMutationTargets(ROOT)
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, executionPlanPath), 'utf8'))
    registryScheduling = { targets, ...schedulingTopology(targets, manifest.units) }
  }
  const registered = registryScheduling.targets[targetId]
  if (registered && registered.packageDirectory === target.packageDirectory)
    return registryScheduling.admitted.get(targetId)
  return upstreamPlans.get(targetId) ?? automaticPlan(targetId, target)
}

export function partitionMutationTarget(targetId, target) {
  const ranges = rangePlans.get(targetId)
  if (ranges) return semanticPartitions(target, ranges, rangeCompanions.get(targetId))
  const refinements = refinedFileParts.get(targetId)
  const parts = executionPartitions(targetId, target, true).flatMap(part => {
    const refinement = refinements?.get(part.id)
    return refinement ? semanticPartitions(part.target, refinement) : [part]
  })
  return withExecutionCompanions(targetId, parts)
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
        partition: id,
        ...(targets[targetId].packageDirectory === 'packages/wallet/wallet-toolbox'
          ? { wallet_native: true }
          : {})
      }))
    })
  }
}

export function longestFirst(matrix, seconds) {
  const cost = row => seconds[`${row.target}/${row.partition}`] ?? Number.MAX_SAFE_INTEGER
  return {
    include: matrix.include
      .map((row, index) => ({ row, index }))
      .sort((left, right) => cost(right.row) - cost(left.row) || left.index - right.index)
      .map(({ row }) => row)
  }
}

export function scheduledMutationExecutionMatrix(selected, targets, seconds) {
  return longestFirst(mutationExecutionMatrix(selected, targets), seconds)
}
