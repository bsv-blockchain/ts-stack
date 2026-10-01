---
id: compiled-package-examples
title: 'Compiled Package Boundary Examples'
kind: guide
version: '1.0.0'
last_updated: '2026-09-30'
last_verified: '2026-09-30'
review_cadence_days: 30
status: stable
tags: [guide, typescript, packages, consumers, examples]
---

# Compiled Package Boundary Examples

These examples are deliberately small. Their purpose is to prove that public
entry points across the stack remain usable together from clean, packed npm
artifacts. `pnpm docs:examples` extracts every fence marked `compile`, packs the
referenced packages and their first-party dependency closure, installs those
tarballs in a temporary consumer with lifecycle scripts disabled, and runs the
native TypeScript compiler.

They validate package names, exports, declarations, module resolution, and
cross-package type identity. They do not replace behavioral examples, package
tests, browser/mobile bundles, or live-service integration tests.

## Original root coordination contracts

This helper prepares an owned local record for a future atomic intake transaction.
It performs no persistence or request effect. Recovery uses that original record
and selector; current authorization remains a separate obligation.

```ts compile
// example-id: root-coordination-contract
import {
  RootEvictionContracts,
  type RootEvictionCapabilityTrust
} from '@bsv/output-knowledge/root-eviction'

function selectRootCoordinationContract(
  trust: RootEvictionCapabilityTrust,
  signedManifest: unknown,
  authenticatedSelector: string,
  initiationTime: string
) {
  const contracts = new RootEvictionContracts(trust)
  return contracts.retain(signedManifest, authenticatedSelector, initiationTime)
}
```

## Checked root decision observations

The host supplies synchronous clock, access and context ports that participate
in the journal's actual gate. These types preserve the observed revision for the
later signing and final enqueue stage. This example does not install a root policy
or network route; see the [root coordination guide](./root-eviction-coordination.md).

```ts compile
// example-id: root-checked-observation
import type {
  RootEvictionCheckedStorage,
  RootEvictionCommitGuard,
  RootEvictionObservation
} from '@bsv/output-knowledge/root-eviction'
import type { OutputRootEvictionResult } from '@bsv/sdk'

async function readAuthorizedRootDecision(
  journal: RootEvictionCheckedStorage,
  authenticatedRequester: string,
  requestId: string,
  guard: RootEvictionCommitGuard
): Promise<RootEvictionObservation<OutputRootEvictionResult>> {
  return journal.resultChecked(authenticatedRequester, requestId, guard)
}
```

## Private publication, lookup and purchase contracts

These functions run only after the caller has authenticated the complete service
response. Original requests, selected seller/rules and retained quotes come from
the caller's durable operation record. The returned values describe bound claims;
they do not establish payment acceptance, topical durability, mined inclusion or
whether private context can actually be used. The
[private-overlay guide](./private-overlay-release.md) explains those separate
obligations. This example performs no payment, signing or network request.

```ts compile
// example-id: private-overlay-contracts
import {
  parseOutputPrivatePublish,
  outputPrivatePublicationRequestDigest
} from '@bsv/sdk/overlay-tools/OutputPrivatePublicationProtocol'
import {
  bindOutputPaidLookupChallenge,
  bindOutputPaidLookupAcquired,
  type OutputPaidLookupChallenge
} from '@bsv/sdk/overlay-tools/OutputPaidLookupProtocol'
import {
  parseOutputPurchasePrepare,
  verifyOutputPurchaseTerms,
  verifyOutputPurchaseEnvelope,
  type OutputSignedPurchaseTerms
} from '@bsv/sdk/overlay-tools/OutputPurchaseProtocol'
import {
  inspectOutputPaidLookupFunding,
  type OutputWalletFundingOperation
} from '@bsv/sdk/overlay-tools/OutputPaidLookupFunding'
import type { parseOutputChain } from '@bsv/sdk'

function publicationSemanticFence(publication: unknown) {
  const owned = parseOutputPrivatePublish(publication)
  return { owned, digest: outputPrivatePublicationRequestDigest(owned) }
}

function checkAuthenticatedQuote(
  response: unknown,
  originalRequest: unknown,
  selected: { seller: string; rulesDigest: string }
): OutputPaidLookupChallenge {
  return bindOutputPaidLookupChallenge(response, originalRequest, selected)
}

function checkAuthenticatedPaidResult(
  response: unknown,
  originalRequest: unknown,
  retainedQuote: OutputPaidLookupChallenge,
  selected: { seller: string; rulesDigest: string }
) {
  return bindOutputPaidLookupAcquired(response, retainedQuote, originalRequest, selected)
}

function checkPurchaseTerms(
  response: unknown,
  originalRequest: unknown,
  selectedSeller: string
): OutputSignedPurchaseTerms {
  return verifyOutputPurchaseTerms(
    response,
    parseOutputPurchasePrepare(originalRequest),
    selectedSeller
  )
}

function checkAuthenticatedPurchaseResult(
  response: unknown,
  retainedTerms: OutputSignedPurchaseTerms,
  constructedTransactionId: string
) {
  return verifyOutputPurchaseEnvelope(response, retainedTerms, constructedTransactionId)
}

function inspectSelectedPayment(
  payment: unknown,
  retainedQuote: OutputPaidLookupChallenge,
  selected: { chain: ReturnType<typeof parseOutputChain>; sellerPaymentKey: string }
): OutputWalletFundingOperation {
  return inspectOutputPaidLookupFunding(payment, retainedQuote, selected).operation
}

void publicationSemanticFence
void checkAuthenticatedQuote
void checkAuthenticatedPaidResult
void checkPurchaseTerms
void checkAuthenticatedPurchaseResult
void inspectSelectedPayment
```

## Root advertisement response admission

Capture the revision before loading the complete response. The installed reader
supplies every disclosed advertisement; current data and control access checks
share the journal's gate with all policy writers. This example establishes public
type composition, not a complete root service or requester policy.

```ts compile
// example-id: root-advertisement-response
import {
  guardRootAdvertisementResponse,
  type RootAdvertisementResponseGuard
} from '@bsv/overlay-express/root-eviction-response'
import { SQLiteRootEvictionStore as HTTPRootJournal } from '@bsv/output-knowledge/root-eviction/sqlite'

async function serveAdvertisements(
  response: Parameters<typeof guardRootAdvertisementResponse>[0],
  journal: HTTPRootJournal,
  read: () => Promise<{ body: string; targets: RootAdvertisementResponseGuard['targets'] }>,
  authorize: RootAdvertisementResponseGuard['authorize'],
  controlHeaders: RootAdvertisementResponseGuard['controlHeaders']
): Promise<void> {
  const { revision } = await journal.head()
  const result = await read()
  guardRootAdvertisementResponse(response, {
    journal,
    revision,
    targets: result.targets,
    authorize,
    controlHeaders
  })
  response.status(200).set('content-type', 'application/json').end(result.body)
}

void serveAdvertisements
```

## Final authenticated response admission

This interface example requires an application-owned durable fence. Every writer
that can revoke access or suppress a disclosed target must acquire its paired
write gate. The example's fence implementation is intentionally supplied by the
host; an in-process callback alone does not prove cross-process ordering.

```ts compile
// example-id: authenticated-response-admission
import {
  guardAuthenticatedResponse,
  type AuthenticatedResponseCandidate
} from '@bsv/auth-express-middleware'

interface DurableSendFence {
  withReadGate(signal: AbortSignal, commit: () => void): Promise<void>
  currentAccess(identityKey: string): boolean
  candidateStillCurrent(candidate: AuthenticatedResponseCandidate): boolean
}

type GuardedHTTPResponse = Parameters<typeof guardAuthenticatedResponse>[0]

function installFinalAdmission(res: GuardedHTTPResponse, fence: DurableSendFence) {
  guardAuthenticatedResponse(res, async (candidate, enqueue, signal) => {
    let stale = false
    await fence.withReadGate(signal, () => {
      if (!fence.currentAccess(candidate.identityKey)) throw new Error('Access revoked')
      if (fence.candidateStillCurrent(candidate)) enqueue()
      else stale = true
    })
    if (stale && candidate.attempt === 0) {
      return {
        statusCode: 409,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          'x-bsv-result': 'reset-required'
        },
        body: new TextEncoder().encode(JSON.stringify({ error: 'reset-required' }))
      }
    }
  })
}

void installFinalAdmission
```

The second attempt must also pass current access and the host's control-response
policy. Add the deployment's required CORS and profile headers to the replacement.
No body or header from the discarded candidate is inherited automatically.

## SDK and high-level helpers

```ts compile
// example-id: sdk-and-simple
import { PrivateKey } from '@bsv/sdk'
import { createWallet, type BrowserWallet } from '@bsv/simple/browser'

const exampleIdentityKey: string = PrivateKey.fromRandom().toPublicKey().toString()
const connectExampleWallet: () => Promise<BrowserWallet> = createWallet

void exampleIdentityKey
void connectExampleWallet
```

## Credentials and identity

```ts compile
// example-id: credentials-and-identity
import { BsvDid, type DidDocument } from '@bsv/did'
import type { DIDQuery } from '@bsv/overlay-topics'

// Declared rather than derived from `PrivateKey`, so this fence compiles on its
// own. Only fences importing a changed package are selected, so the one above
// is absent whenever `@bsv/sdk` is unchanged, and a fence that reaches across to
// it fails for reasons that have nothing to do with the boundary under test.
declare const examplePublicKeyDer: number[]

const exampleDidDocument: DidDocument = BsvDid.toDidDocument(
  BsvDid.fromPublicKey(examplePublicKeyDer)
)
const acceptDidLookup = (query: DIDQuery): DIDQuery => query

void exampleDidDocument
void acceptDidLookup
```

The compiler combines the _selected_ fences into one consumer module, and on a
pull request it selects only the fences whose import closure reaches a changed
package. So an earlier fence's imports are available only when that fence
happened to be selected too, and a fence that leans on one is broken by any
change that does not touch it. Each fence declares everything it names.

## Messaging

```ts compile
// example-id: messaging
import type { MessageBoxClientOptions } from '@bsv/message-box-client'
import type { PublicProfile } from '@bsv/paymail'

const exampleMessageBoxOptions: MessageBoxClientOptions = {
  host: 'https://messagebox.example',
  socketOptions: { managerOptions: { transports: ['websocket'] } }
}
const exampleProfileConsumer = (profile: PublicProfile): string => profile.name

void exampleMessageBoxOptions
void exampleProfileConsumer
```

Public Message Box deployments may serve previously unknown application
origins. An operator allowlist is optional deployment configuration; it does
not replace BRC authentication, permissions, signatures, replay protection, or
request bounds.

## Authentication and HTTP payments

```ts compile
// example-id: middleware
import { AuthProofClient, type AuthProofOptions } from '@bsv/auth'
import { create402Fetch, type Payment402Options } from '@bsv/402-pay'
import type { AuthRequest } from '@bsv/auth-express-middleware'
import type { PaymentRequest } from '@bsv/payment-express-middleware'

const exampleAuthOptions: AuthProofOptions = {
  protocol: [2, 'compiled docs example']
}
const exampleAuthClient = new AuthProofClient(exampleAuthOptions)
const buildPaidFetch = (options: Payment402Options) => create402Fetch(options)
const acceptAuthRequest = (request: AuthRequest): AuthRequest => request
const acceptPaymentRequest = (request: PaymentRequest): PaymentRequest => request

void exampleAuthClient
void buildPaidFetch
void acceptAuthRequest
void acceptPaymentRequest
```

## Overlay and synchronization

```ts compile
// example-id: overlay-and-gasp
import type { TopicBlockAnchor } from '@bsv/overlay'
import type { GASPStorage } from '@bsv/gasp'
import type { AnyQuery } from '@bsv/overlay-topics'
import type OverlayExpress from '@bsv/overlay-express'

const exampleAnchorConsumer = (anchor: TopicBlockAnchor): number => anchor.blockHeight
const exampleStorageConsumer = (storage: GASPStorage): GASPStorage => storage
const exampleAnyQuery: AnyQuery = {}
const acceptOverlayServer = (server: OverlayExpress): OverlayExpress => server

void exampleAnchorConsumer
void exampleStorageConsumer
void exampleAnyQuery
void acceptOverlayServer
```

## Wallet storage clients

```ts compile
// example-id: wallet-storage
import type { SetupWalletArgs } from '@bsv/wallet-toolbox'
import { StorageClient } from '@bsv/wallet-toolbox-client'
import type { WalletRelayServiceOptions } from '@bsv/wallet-relay'

const exampleWalletSetup = (args: SetupWalletArgs): SetupWalletArgs => args
type ExampleStorageOptions = ConstructorParameters<typeof StorageClient>[2]
const acceptStorageOptions = (options: ExampleStorageOptions): ExampleStorageOptions => options
const acceptRelayOptions = (options: WalletRelayServiceOptions): WalletRelayServiceOptions =>
  options

void exampleWalletSetup
void acceptStorageOptions
void acceptRelayOptions
```

Remote Wallet Storage is a public service in many deployments. Keep its
cross-domain default configurable and public unless an operator explicitly
enables an origin allowlist; enforce authorization and identity isolation
regardless of CORS mode.

## Network messages

```ts compile
// example-id: network
import { tryDecodeMessage, type DecodedMessage } from '@bsv/teranode-listener'

const decodeNetworkMessage = (bytes: Uint8Array): DecodedMessage | null => tryDecodeMessage(bytes)

void decodeNetworkMessage
```

## WASM verification

```ts compile
// example-id: verifast
import { BdkVerifier, type BdkVerifierOptions } from '@bsv/verifast'

const exampleVerifierOptions: BdkVerifierOptions = { mode: 'auto' }
const exampleVerifier = new BdkVerifier(exampleVerifierOptions)

void exampleVerifier
```

Run:

```bash
pnpm build
pnpm docs:examples
```

The command requires built package outputs and network access only when the
clean temporary consumer's external dependencies are not already present in
the pnpm store. It never publishes or deploys an artifact.

## Durable lookup provider

This unpublished candidate composes the portable provider, Node storage and
optional dual-format HTTP adapter. Creation and reopening are deliberately
separate: callers retain the epoch, signed manifest, immutable binding and storage
configuration as described in the [provider guide](durable-live-lookup.md).

```ts compile
// example-id: durable-lookup-provider
import {
  LookupProviderService as ExampleLookupProvider,
  LookupSessionCodec as ExampleLookupCodec,
  type LookupProviderOptions as ExampleLookupOptions
} from '@bsv/output-knowledge/lookup'
import {
  SQLiteLookupIndex as ExampleLookupIndex,
  SQLiteLookupSessions as ExampleLookupSessions
} from '@bsv/output-knowledge/lookup/sqlite'
import {
  createOutputLookupRouter as exampleLookupRouter,
  type OutputLookupRouteOptions as ExampleLookupRoutes
} from '@bsv/overlay-express/output-lookup'
import type ExampleLookupHost from '@bsv/overlay-express'

function reopenExampleLookupStorage(path: string, codec: ExampleLookupCodec, now: () => string) {
  const index = ExampleLookupIndex.open(path, 'records', { service: 'records' })
  const sessions = ExampleLookupSessions.open(index, codec, now)
  return { index, sessions }
}

function composeExampleLookup(
  options: ExampleLookupOptions,
  routes: Omit<ExampleLookupRoutes, 'companion'>
) {
  const companion = new ExampleLookupProvider(options)
  return { companion, router: exampleLookupRouter({ ...routes, companion }) }
}

function configureExampleLookupHost(
  host: ExampleLookupHost,
  options: ExampleLookupOptions,
  routes: Omit<ExampleLookupRoutes, 'companion' | 'authenticate' | 'handleHandshake'>
) {
  const companion = new ExampleLookupProvider(options)
  host.configureOutputLookup({ ...routes, companion })
  return companion
}

void reopenExampleLookupStorage
void composeExampleLookup
void configureExampleLookupHost
```

## Revenue listing recognition

The executable is supplied from a pinned local artifact. This example checks
the portable exact-script API; lineage, currentness and spending are separate.

```typescript compile
// example-id: revenue-listing-codec
import {
  RevenueListing,
  parseRevenueListingDescriptor,
  revenueListingId,
  encodeRevenueListingState,
  decodeRevenueListingState
} from '@bsv/sdk/script/templates/RevenueListing'

export function recognizeListing(
  program: Uint8Array,
  script: Uint8Array,
  descriptorInput: unknown
) {
  const family = new RevenueListing(program)
  const descriptor = parseRevenueListingDescriptor(descriptorInput)
  const state = family.decode(script, descriptor)
  const stateBytes = encodeRevenueListingState(state)
  return {
    listingId: revenueListingId(descriptor),
    state: decodeRevenueListingState(stateBytes),
    script: family.lock(descriptor, state).toBinary()
  }
}
```

## Revenue listing funded signing boundary

```typescript compile
// example-id: revenue-listing-spend
import { RevenueListing as ListingCodec } from '@bsv/sdk/script/templates/RevenueListing'
import {
  RevenueListingSpend,
  type RevenueListingSigningRequest
} from '@bsv/sdk/script/templates/RevenueListingSpend'
import type { Transaction as FundedTransaction } from '@bsv/sdk'

export function bindListingFunding(
  codec: ListingCodec,
  descriptor: unknown,
  previous: unknown,
  action: unknown,
  funded: FundedTransaction
) {
  const spend = new RevenueListingSpend(codec, descriptor, previous, action)
  const prepared = spend.prepare(funded)
  const requests: RevenueListingSigningRequest[] = prepared.signingRequests()
  return { plan: spend.plan(), requests, prepared }
}
```

The caller establishes lineage first and obtains transaction signatures from an
explicit authority. Final layout validation remains separate from full transaction
and Script verification, private fulfillment and wallet operation recovery.

## Revenue listing full-history verification

```typescript compile
// example-id: revenue-listing-lineage
import { RevenueListing as HistoryCodec } from '@bsv/sdk/script/templates/RevenueListing'
import {
  RevenueListingLineageVerifier,
  RevenueListingAuthority,
  type RevenueListingAuthorityPort,
  type ChainViewResolver as RevenueChainViewResolver,
  type VerificationContext as RevenueVerificationContext
} from '@bsv/output-knowledge/revenue-listing'

export function installDedicatedRevenueAuthority(port: RevenueListingAuthorityPort) {
  return new RevenueListingAuthority(port)
}

export function installRevenueHistory(program: Uint8Array, chains: RevenueChainViewResolver) {
  return new RevenueListingLineageVerifier(new HistoryCodec(program), chains)
}

export async function inspectRevenueHistory(
  verifier: RevenueListingLineageVerifier,
  packet: unknown,
  context: RevenueVerificationContext,
  signal: AbortSignal
) {
  return await verifier.verify(packet, context, signal)
}
```

Install and reuse the verifier under a trusted immutable chain view. The caller
compares the returned target with the selected input and separately checks asset
authority, currentness and acquisition association before any wallet action.

## Local wallet recovery capabilities

These constructors are for trusted local wallet integrations after explicit
same-database installation. They perform no wallet action or network request.
See [action recovery](./local-action-recovery.md) and
[funding recovery](./local-funding-recovery.md) for lifecycle and backup limits.

```typescript compile
// example-id: local-wallet-recovery
import type { Wallet as LocalWallet } from '@bsv/wallet-toolbox'
import { SQLiteActionRecoveryStore } from '@bsv/wallet-toolbox/out/src/storage/actionRecovery/SQLiteActionRecoveryStore'
import { RecoverableActionController } from '@bsv/wallet-toolbox/out/src/signer/actionRecovery/RecoverableActionController'
import { SQLiteFundingRecoveryStore } from '@bsv/wallet-toolbox/out/src/storage/fundingRecovery/SQLiteFundingRecoveryStore'
import { RecoverableFundingController } from '@bsv/wallet-toolbox/out/src/signer/fundingRecovery/RecoverableFundingController'

export function installLocalRecoveryControllers(
  wallet: LocalWallet,
  actions: SQLiteActionRecoveryStore,
  funding: SQLiteFundingRecoveryStore,
  originator: string
) {
  return {
    actions: new RecoverableActionController(wallet, actions, originator),
    funding: new RecoverableFundingController(wallet, funding)
  }
}
```

## Root advertisement request and result binding

These functions receive independently authenticated context and retained request
policy. They validate attributable protocol claims without authorizing or applying
suppression. Apply the clock check only on new requests, after checking the durable
request fence; exact retries recover their saved outcome under current access rules.
See [root coordination](./root-eviction-coordination.md) for the serving obligations.

```typescript compile
// example-id: root-eviction-contracts
import type { OutputChain, OutputSignedRootEvictionRequest } from '@bsv/sdk'
import {
  verifyOutputRootEvictionRequest,
  validateOutputRootEvictionWindow,
  verifyOutputRootEvictionResult
} from '@bsv/sdk/overlay-tools/OutputRootEvictionProtocol'

export function authenticateRootRequest(
  bytes: Uint8Array,
  transport: { requester: string },
  installed: { root: string; chain: OutputChain }
) {
  return verifyOutputRootEvictionRequest(bytes, { ...installed, requester: transport.requester })
}

export function checkNewRequestClock(request: OutputSignedRootEvictionRequest, now: string) {
  return validateOutputRootEvictionWindow(request, {
    now,
    maximumLifetimeSeconds: '3600',
    futureClockSeconds: '30'
  })
}

export function authenticateRootResult(
  bytes: Uint8Array,
  original: OutputSignedRootEvictionRequest,
  retainedEvaluationPolicy: string
) {
  return verifyOutputRootEvictionResult(bytes, original, retainedEvaluationPolicy)
}
```

## Root decision projection

This function demonstrates the durable journal's projection handshake. The installed
adapter must apply each intent idempotently to its actual index and coherent live
membership stream before acknowledging it. A newer decision can supersede the intent
while the adapter is working, so the serving gate remains authoritative.

```typescript compile
// example-id: root-decision-projection
import type {
  RootEvictionProjection,
  RootEvictionStorage
} from '@bsv/output-knowledge/root-eviction'
import { SQLiteRootEvictionStore } from '@bsv/output-knowledge/root-eviction/sqlite'

export async function projectRootDecisions(
  journal: RootEvictionStorage,
  applyDurably: (intent: RootEvictionProjection) => Promise<void>
) {
  const results: boolean[] = []
  for (const intent of await journal.projections(64)) {
    await applyDurably(intent)
    results.push(await journal.projected(intent))
  }
  return results
}

export function recoverRootJournal(
  path: string,
  configuration: Parameters<typeof SQLiteRootEvictionStore.open>[1]
): RootEvictionStorage {
  return SQLiteRootEvictionStore.open(path, configuration)
}
```

## Root advertisement evidence

This adapter uses the caller's independently installed immutable chain view.
Its result supplies verified facts to local policy; it does not authorize a
suppression or restoration, assess currentness, or modify the journal.

```typescript compile
// example-id: root-advertisement-evidence
import type { ChainViewResolver, VerificationContext } from '@bsv/output-knowledge'
import { SDKRootEvictionEvidence } from '@bsv/output-knowledge/root-eviction/evidence'

export function createRootEvidenceVerifier(chains: ChainViewResolver) {
  return new SDKRootEvictionEvidence(chains)
}

export async function verifySelectedAdvertisement(
  verifier: SDKRootEvictionEvidence,
  signedRequest: unknown,
  targetIndex: number,
  installedContext: VerificationContext,
  signal: AbortSignal
) {
  return verifier.verify(signedRequest, targetIndex, installedContext, signal)
}
```

## Atomic root coordination intake

The host supplies an authenticated requester and selection, installed capability
rules and trusted synchronous commit guards. It sets `futureClockSeconds` from
its own finite clock policy, never from an untrusted request body. This example only records and reads
the request. Installed evidence policy decides any subsequent suppression.

```typescript compile
// example-id: atomic-root-coordination
import type {
  RootEvictionContracts as IntakeContracts,
  RootEvictionCommitGuard as IntakeCommitGuard,
  RootEvictionCoordinatedStorage,
  RootEvictionConfiguration
} from '@bsv/output-knowledge/root-eviction'
import { SQLiteRootEvictionStore as CoordinatedRootJournal } from '@bsv/output-knowledge/root-eviction/sqlite'

export function explicitlyUpgradeRoot(
  path: string,
  existingConfiguration: RootEvictionConfiguration
): RootEvictionCoordinatedStorage {
  return CoordinatedRootJournal.upgradeCoordination(path, {
    ...existingConfiguration,
    coordination: { contractBytes: 16 * 1024 * 1024 }
  })
}

export async function recordSelectedRootRequest(
  store: RootEvictionCoordinatedStorage,
  request: unknown,
  authenticatedRequester: string,
  selection: { manifest: unknown; selector: string; futureClockSeconds: string },
  contracts: IntakeContracts,
  guard: IntakeCommitGuard
) {
  const retained = await store.retainCoordinated(
    request,
    authenticatedRequester,
    selection,
    contracts,
    guard
  )
  return store.resultCoordinated(
    authenticatedRequester,
    retained.value.request.body.requestId,
    selection.selector,
    contracts,
    guard
  )
}
```

## Bounded root expiry recovery

Call one page from an installed, bounded host worker. Keep its returned cursor
for the next page; an undefined cursor ends a pass, and the next scheduled pass
starts without one. The database already exists. This example expires work only;
it grants no automatic requester authority and does not install a service timer.

```typescript compile
// example-id: root-expiry-maintenance
import { SQLiteRootEvictionMaintenance } from '@bsv/output-knowledge/root-eviction/sqlite'
import type {
  RootEvictionConfiguration as MaintenanceConfiguration,
  RootEvictionMaintenanceGuard
} from '@bsv/output-knowledge/root-eviction'

export async function expireOneRootPage(
  path: string,
  configuration: MaintenanceConfiguration,
  guard: RootEvictionMaintenanceGuard,
  after?: string
): Promise<string | undefined> {
  const worker = SQLiteRootEvictionMaintenance.open(path, configuration)
  try {
    const page = await worker.pendingPage({ maximum: 8, after }, guard)
    for (const digest of page.value.digests) await worker.expirePending(digest, guard)
    return page.value.next
  } finally {
    await worker.close()
  }
}
```

## Recover a selected root operation

This is an installed worker read after bounded pending discovery and independent
expiry maintenance. The guard authorizes the worker; it is not constructed by
pretending to be the requester. No current manifest is consulted.

```typescript compile
// example-id: root-original-contract-recovery
import type {
  RootEvictionRecoveryStorage,
  RootEvictionContracts as RecoveryRootContracts,
  RootEvictionCommitGuard as RecoveryRootGuard
} from '@bsv/output-knowledge/root-eviction'

export async function recoverOriginalRootOperation(
  store: RootEvictionRecoveryStorage,
  digest: string,
  contracts: RecoveryRootContracts,
  installedWorkerGuard: RecoveryRootGuard
) {
  return store.recoverCoordinated(digest, contracts, installedWorkerGuard)
}
```

## Sign a retained root status for guarded delivery

Install explicit status authority and the root signer. This returns a candidate
for the separate native final-enqueue companion, which must recheck current access
and `head.revision` with an empty advertisement inventory. It does not send bytes,
mount an endpoint or authorize a peer decision.

```typescript compile
// example-id: root-status-signing
import {
  RootEvictionService,
  type RootEvictionServiceOptions,
  type RootEvictionCaller
} from '@bsv/output-knowledge/root-eviction'

export function createRootStatusHandler(installed: RootEvictionServiceOptions) {
  // One shared instance per installed service, not a fresh capacity pool per request.
  const service = new RootEvictionService(installed)
  return async (
    receivedUTF8Text: string,
    authenticatedCaller: RootEvictionCaller,
    signal: AbortSignal
  ) => service.status(receivedUTF8Text, authenticatedCaller, signal)
}
```

## Compose root coordination intake with authenticated HTTP

Install the router before generic parsers, using the same durable store for
retention, observed results and native final enqueue. Configure the origin's
shared authentication middleware and current access callbacks explicitly. This
composition does not advertise capabilities or enable automatic peer decisions.

```typescript compile
// example-id: root-coordination-http
import {
  createRootEvictionRouter,
  type RootEvictionRouteOptions
} from '@bsv/overlay-express/root-eviction'
import {
  RootEvictionService as HTTPRootService,
  type RootEvictionServiceOptions as HTTPRootServiceOptions
} from '@bsv/output-knowledge/root-eviction'
import { SQLiteRootEvictionStore as CoordinationHTTPJournal } from '@bsv/output-knowledge/root-eviction/sqlite'

export function createRootCoordinationHTTP(
  journal: CoordinationHTTPJournal,
  service: Omit<HTTPRootServiceOptions, 'journal'>,
  http: Omit<RootEvictionRouteOptions, 'journal' | 'companion'>
) {
  const companion = new HTTPRootService({ ...service, journal })
  return createRootEvictionRouter({ ...http, journal, companion })
}
```

The same component can be installed through the native host before startup. The
application keeps the journal and worker shutdown order; neither composition
automatically publishes the complete profile.

```typescript compile
// example-id: root-coordination-host
import NativeRootHost from '@bsv/overlay-express'
import type { RootEvictionRouteOptions as NativeRootRoutes } from '@bsv/overlay-express/root-eviction'

export function configureRootCoordinationHost(
  host: NativeRootHost,
  options: Omit<NativeRootRoutes, 'authenticate' | 'handleHandshake'> & { identity: string }
): void {
  host.configureRootEviction(options)
}
```

## Resume a retained root coordination operation

Load these options from trusted configuration and integrity-protected local
operation storage. The original request, capability and evaluation policy must
already have been saved; the client performs no discovery or persistence.

```typescript compile
// example-id: root-coordination-client
import {
  OutputRootEvictionTransport as RetainedRootClient,
  type OutputRootEvictionTransportOptions as RetainedRootClientOptions
} from '@bsv/sdk'

export async function readOriginalRootDecision(options: RetainedRootClientOptions) {
  const client = new RetainedRootClient(options)
  return await client.status()
}
```

## Own the root recovery lifecycle

Supply ports for the same existing sealed journal. Omit automatic evaluation for
manual/advisory handling. This function observes the background lifetime, drains
physical work on shutdown and leaves database close ownership with its caller.

```typescript compile
// example-id: root-recovery-lifecycle
import {
  RootEvictionScheduler,
  type RootEvictionSchedulerOptions,
  type RootEvictionScheduleReport
} from '@bsv/output-knowledge/root-eviction'

export async function runRootRecoveryUntilShutdown(
  options: RootEvictionSchedulerOptions,
  onReport: (report: RootEvictionScheduleReport) => void | Promise<void>,
  shutdown: Promise<void>
): Promise<void> {
  const worker = new RootEvictionScheduler(options)
  const completion = worker.start(onReport)
  try {
    await Promise.race([shutdown, completion])
  } finally {
    await worker.stop()
    await completion
  }
}
```
