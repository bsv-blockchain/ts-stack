---
id: compiled-package-examples
title: 'Compiled Package Boundary Examples'
kind: guide
version: '1.1.0'
last_updated: '2026-10-02'
last_verified: '2026-10-02'
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

## Durable ordinary admission for a proposal service

The bridge implements the proposal service's admission port using an explicitly
installed Engine and retained topic receipts. The rest of the service still owns
verification, policy, current access and durable reservation. This compiled
example proves the public port types compose; it does not execute a server.

```ts compile
// example-id: proposal-engine-admission
import type { Engine } from '@bsv/overlay'
import { OverlayProposalAdmission } from '@bsv/overlay/proposal-admission'
import type { ProposalServiceAdmission } from '@bsv/output-knowledge/proposals'

function installedProposalAdmission(
  engine: Engine,
  providerIdentity: string,
  installedRulesDigest: string
): ProposalServiceAdmission {
  return new OverlayProposalAdmission({
    engine,
    identity: providerIdentity,
    rulesDigest: installedRulesDigest,
    service: 'proposal-records',
    topic: 'tm_records',
    maximumOutcomeBytes: 65536,
    maximumConcurrentAdmissions: 4
  })
}
void installedProposalAdmission
```

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
import { BsvDid, type DidDocument, type DidResolutionResult } from '@bsv/did'
import { DID, type DidDocument as SimpleDidDocument } from '@bsv/simple'

// Public BRC-202 specification vector; this is never a production identity.
const exampleIdentityPublicKey =
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const exampleIdentityDid = BsvDid.fromPublicKey(exampleIdentityPublicKey)
const exampleDidDocument: DidDocument = BsvDid.toDidDocument(exampleIdentityDid)
const exampleSimpleDidDocument: SimpleDidDocument = exampleDidDocument
const exampleIdentityResolution: DidResolutionResult = DID.resolve(
  DID.fromIdentityKey(exampleIdentityPublicKey)
)

void exampleSimpleDidDocument
void exampleIdentityResolution
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
  LookupResponseDisclosure as ExampleLookupDisclosure,
  type LookupResponseDisclosureOptions as ExampleDisclosureOptions,
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

function composeExamplePrivateLookup(
  options: ExampleLookupOptions,
  disclosureOptions: ExampleDisclosureOptions,
  routes: Omit<ExampleLookupRoutes, 'companion' | 'disclosure'>
) {
  // Host supplies the same sessions/contracts/authorize/work to both companions.
  const companion = new ExampleLookupProvider(options)
  const disclosure = new ExampleLookupDisclosure(disclosureOptions)
  return exampleLookupRouter({ ...routes, companion, disclosure })
}

void composeExamplePrivateLookup
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

## Local advertisement evidence

Admission and local-rule reassessment can verify the original advertisement
without constructing a peer coordination request. The returned facts still need
an independently installed currentness and serving-policy assessment.

```typescript compile
// example-id: local-root-advertisement-evidence
import type {
  ChainViewResolver as LocalAdvertisementChainResolver,
  VerificationContext as LocalAdvertisementVerificationContext
} from '@bsv/output-knowledge'
import {
  SDKRootAdvertisementEvidence,
  type RootAdvertisementEvidenceInput
} from '@bsv/output-knowledge/root-eviction/evidence'

export async function verifyLocalRootAdvertisement(
  chains: LocalAdvertisementChainResolver,
  input: RootAdvertisementEvidenceInput,
  installedContext: LocalAdvertisementVerificationContext,
  signal: AbortSignal
) {
  return new SDKRootAdvertisementEvidence(chains).verify(input, installedContext, signal)
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

## Assess all installed root rules

Open the already-created format3 journal with its exact configuration. The caller
supplies independently verified currentness and a trusted local evaluator. An
unavailable or unrecognized rule returns `null`. The companion checks the complete
inventory and revision at commit; the serving adapter separately completes the
returned durable projection intents before including the output.

```typescript compile
// example-id: root-local-rule-coverage
import { SQLiteRootEvictionLocalRules } from '@bsv/output-knowledge/root-eviction/sqlite'
import type {
  RootEvictionConfiguration as LocalRulesConfiguration,
  RootEvictionCommitGuard as LocalRulesCommitGuard,
  RootEvictionServingTarget,
  RootEvictionLocalRule
} from '@bsv/output-knowledge/root-eviction'

export async function assessInstalledRootRules(
  path: string,
  configuration: LocalRulesConfiguration,
  guard: LocalRulesCommitGuard,
  operationId: string,
  target: RootEvictionServingTarget,
  eligible: boolean,
  evidenceDigest: string,
  matchVerifiedAdvertisement: (rule: RootEvictionLocalRule) => Promise<boolean | null>
) {
  const rules = SQLiteRootEvictionLocalRules.open(path, configuration)
  try {
    const observed = await rules.active(guard)
    const matches = []
    for (const record of observed.value.rules) {
      matches.push({
        decisionId: record.decisionId,
        matches: await matchVerifiedAdvertisement(record.rule)
      })
    }
    return await rules.assess(
      {
        operationId,
        expectedRevision: observed.head.revision,
        ruleEpoch: observed.value.epoch,
        target,
        eligible,
        evidenceDigest,
        reasonCode: 'installed-advertisement-policy',
        matches
      },
      guard
    )
  } finally {
    await rules.close()
  }
}
```

## Proposal response enqueue after signing

Capture the exact record used to prepare a response. The final transport guard
calls this helper only after signing, supplying the actual native enqueue. The
fresh disclosure predicate checks current access, the retained capability and
its deadline, and the relationship between the response bytes and that record.
It must run synchronously under the journal gate. Control errors use a separate,
explicit authorization path; a missing record is never sufficient.

```typescript compile
// example-id: proposal-native-enqueue
import { canonicalOutputJSON as proposalCanonicalJSON } from '@bsv/sdk'
import type {
  ProposalJournalEntry,
  ProposalJournalResponseReference,
  ProposalJournalSend
} from '@bsv/output-knowledge/proposals'

export async function enqueuePreparedProposal(
  journal: ProposalJournalSend,
  reference: ProposalJournalResponseReference,
  observedEntry: ProposalJournalEntry,
  signedBodyBytes: Uint8Array,
  currentDisclosure: (entry: ProposalJournalEntry, bytes: Uint8Array) => boolean,
  nativeEnqueue: (bytes: Uint8Array) => undefined
): Promise<void> {
  const observed = proposalCanonicalJSON(observedEntry, { bytes: 4194304 })
  await journal.enqueueResponse(
    { reference, bytes: signedBodyBytes },
    (entry, bytes) =>
      entry !== undefined &&
      proposalCanonicalJSON(entry, { bytes: 4194304 }) === observed &&
      currentDisclosure(entry, bytes),
    nativeEnqueue
  )
}
```

## Bind a proposal result to its original request

The service-owned disclosure companion supplies the response semantics for the
native journal gate. The transport authenticates and signs first; it must pass
the actual signed bytes and caller to the final enqueue helper. Keep current
host access in the journal's policy domain. This example does not mount HTTP.

```typescript compile
// example-id: proposal-response-disclosure
import {
  ProposalResponseDisclosure,
  type ProposalResponseDisclosureOptions,
  type ProposalResponseOperation,
  type ProposalServiceCaller,
  type ProposalJournalSend as DisclosureSendJournal
} from '@bsv/output-knowledge/proposals'

export function bindProposalResult(
  options: ProposalResponseDisclosureOptions,
  operation: ProposalResponseOperation,
  originalRequestText: string,
  serviceResult: unknown,
  caller: ProposalServiceCaller
) {
  const bound = new ProposalResponseDisclosure(options).bind(
    operation,
    originalRequestText,
    serviceResult,
    caller
  )
  return {
    body: bound.body,
    enqueue: async (
      journal: DisclosureSendJournal,
      signedBytes: Uint8Array,
      authenticatedIdentity: string,
      nativeEnqueue: (bytes: Uint8Array) => undefined
    ) =>
      journal.enqueueResponse(
        { reference: bound.reference, bytes: signedBytes },
        (entry, bytes) => bound.validate(entry, bytes, authenticatedIdentity),
        nativeEnqueue
      )
  }
}
```

## Compose the optional proposal HTTP router

Use one durable journal and one current synchronous access policy for the service
and final disclosure. The origin supplies its shared bounded authentication
middleware. This function creates a router; the host owns its mounting order,
TLS, storage and workers as described in the [proposal guide](./non-final-proposals.md).

```typescript compile
// example-id: proposal-http-composition
import { createProposalRouter as makeProposalHTTPRouter } from '@bsv/overlay-express/proposals'
import {
  ProposalService as HTTPProposalService,
  ProposalResponseDisclosure as HTTPProposalDisclosure,
  type ProposalServiceOptions as HTTPProposalServiceOptions,
  type ProposalResponseDisclosureOptions as HTTPProposalDisclosureOptions
} from '@bsv/output-knowledge/proposals'
import type { SQLiteProposalJournal as HTTPProposalJournal } from '@bsv/output-knowledge/proposals/sqlite'

export function composeProposalHTTP(
  options: HTTPProposalServiceOptions & { storage: HTTPProposalJournal },
  currentAccess: HTTPProposalDisclosureOptions['access'],
  authorizeControl: (identity: string) => boolean,
  authenticate: Parameters<typeof makeProposalHTTPRouter>[0]['authenticate']
) {
  const shared = { ...options, access: currentAccess }
  return makeProposalHTTPRouter({
    service: new HTTPProposalService(shared),
    disclosure: new HTTPProposalDisclosure(shared),
    journal: options.storage,
    baseURL: options.trust.baseURL,
    authenticate,
    authorizeControl
  })
}
```

## Original BRC52 certificate envelope

This offline public test vector exercises the proposed BRC203 exporter and strict
verification without signing, provider lookup or wallet operations. A successful
cryptographic result leaves issuer trust and application reliance undecided.

```ts compile
// example-id: brc52-original-envelope
import {
  exportBRC52Envelope,
  parseBRC52Envelope,
  verifyBRC52Envelope,
  type BRC52VerificationResult
} from '@bsv/did/brc52'

const exampleFrozenBRC52 =
  'EREREREREREREREREREREREREREREREREREREREREREiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIgLGBH+UQe19bTBFQG6VwHzYXHeOS4zvPKerrAm5XHCe5QL5MIoBkljDEEk0T4X4nVIptTHIRYNvmbCGAfETvOA2+TMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzAQIFZW1haWxcVVZGUlVWRlJVVkZSVVZGUlVWRlJVVkZSVVZGUlVWRlJVVkZSVVZGUlVWRWZLb2dPdHExcjV6QUpSblVTejEwM2Q3KzBzWU1WNk4yR2I4eFA1Z2FWRUtVaEF0OHEEbmFtZVRVbEpTVWxKU1VsSlNVbEpTVWxKU1VsSlNVbEpTVWxKU1VsSlNVbEpTVWxJQmJZRm55NjRWcEw0VU9FcnU5V3RJMHJ3UUdPRlVCTjZvUngreUxBPT0wRQIhANMWdEUAF6o+tEnqiQqXaU8hQbo0qgN8jXfE0+H/mjSLAiAWM62TibaYVrbEbV1wSnRxp8kShtEduaCUdmrudO28vw=='
const exampleOriginalBytes = Uint8Array.from(atob(exampleFrozenBRC52), character =>
  character.charCodeAt(0)
)
const exampleEnvelope = exportBRC52Envelope(exampleOriginalBytes)
const exampleTransport = JSON.stringify(exampleEnvelope)
const exampleVerification: BRC52VerificationResult = verifyBRC52Envelope(
  'application/json',
  exampleTransport
)
if (!exampleVerification.verified) throw new Error(exampleVerification.errors.join('; '))
if (parseBRC52Envelope(exampleTransport).envelope.certificateBinary !== exampleFrozenBRC52)
  throw new Error('Original signed bytes changed')
```

## Recover an original proposal finalization

The application supplies the original request and capability from trusted durable
storage. A different reservation is an explicit result to reconcile, never an
instruction to construct or fund a replacement transaction.

```typescript compile
// example-id: proposal-client-recovery
import {
  OutputProposalTransport as SavedProposalTransport,
  type OutputProposalTransportOptions as SavedProposalOptions
} from '@bsv/sdk'

export async function recoverSavedFinalization(options: SavedProposalOptions<'finalize'>) {
  const result = await new SavedProposalTransport(options).send()
  return {
    state: result.response.state,
    belongsToSavedRequest: result.matchesRequest
  }
}
```

## Maintain retained proposal work

The host opens an existing journal, constructs its trusted service, and supplies
its lifecycle observer. Observe the returned lifetime and shutdown report before
closing storage. No new finalization is exposed by the worker ports.

```typescript compile
// example-id: proposal-maintenance
import {
  ProposalJournalMaintenance as RetainedProposalInventory,
  ProposalScheduler as RetainedProposalScheduler,
  type ProposalJournalStorage as RetainedProposalJournal,
  type ProposalMaintenanceService as RetainedProposalService,
  type ProposalScheduleReport as RetainedProposalReport
} from '@bsv/output-knowledge/proposals'

export function maintainRetainedProposals(
  storage: RetainedProposalJournal,
  service: RetainedProposalService,
  onPass: (report: RetainedProposalReport) => void | Promise<void>
) {
  const worker = new RetainedProposalScheduler({
    source: new RetainedProposalInventory(storage),
    service
  })
  return { worker, lifetime: worker.start(onPass) }
}
```

## Local protocol publication deadlines

A custom protocol worker can expose its earliest exclusive deadline without
creating a Bitcoin outpoint. The supplied protocol still implements validated,
durable invalidation; the runtime schedules it and closes stale publication.
This composition alone does not implement proposal acceptance or UI expiry.

```ts compile
// example-id: output-runtime-publication-deadline
import {
  OutputKnowledge,
  type OutputKnowledgeWorker,
  type KnowledgeStore,
  type AcceptedInput,
  type DomainProjector
} from '@bsv/output-knowledge'

interface InstalledProtocol {
  advance(store: KnowledgeStore, signal: AbortSignal): Promise<void>
  pendingBytes(store: KnowledgeStore, signal: AbortSignal): Promise<number>
  // Pure, exact U64 epoch seconds derived from this accepted snapshot.
  // advance commits the due invalidation before a fresh projection can publish.
  nextInvalidation(input: AcceptedInput): string | undefined
}

export function createDeadlineAwareRuntime(
  store: KnowledgeStore,
  protocol: InstalledProtocol,
  projector: DomainProjector
): OutputKnowledge {
  const worker: OutputKnowledgeWorker = {
    advance: (selectedStore, signal) => protocol.advance(selectedStore, signal),
    pendingBytes: (selectedStore, signal) => protocol.pendingBytes(selectedStore, signal),
    nextInvalidation: input => protocol.nextInvalidation(input)
  }
  return new OutputKnowledge({ store, worker, projector })
}
```

## Receive authenticated proposal observations

Use a new journal namespace for this opt-in mode. The source rule must be derived
from an independently authenticated selection; this example does not discover a
provider, define a current-channel query, or authorize an application effect.
The store, worker and runtime share the same clock and account partition.

```ts compile
// example-id: output-proposal-client-acceptance
import {
  BitcoinKnowledge,
  KnowledgeStore as ProposalJournalStore,
  OutputKnowledge as ProposalRuntime,
  type EvidenceVerifier,
  type JournalStorage
} from '@bsv/output-knowledge'
import {
  ProposalSourcePolicy,
  type ProposalPolicyRegistry,
  type ProposalSourceRule
} from '@bsv/output-knowledge/proposals'
import type { OutputPartition } from '@bsv/sdk'

export function receiveProposalObservations(options: {
  storage: JournalStorage
  partition: OutputPartition
  verifier: EvidenceVerifier
  policies: ProposalPolicyRegistry
  reader: string
  source: ProposalSourceRule
  now: () => number
}): { store: ProposalJournalStore; runtime: ProposalRuntime } {
  const proposals = new ProposalSourcePolicy(options.policies, options.reader, [options.source])
  const worker = new BitcoinKnowledge({
    journalId: options.storage.namespace,
    partition: options.partition,
    nonFinal: true,
    proposals,
    verifier: options.verifier,
    now: options.now
  })
  const store = new ProposalJournalStore(options.storage, worker, {
    partition: options.partition,
    now: options.now
  })
  const runtime = new ProposalRuntime({ store, worker, now: options.now })
  // Commit the verification context, then add explicitly authenticated sources.
  // Render accepted proposals separately from Bitcoin facts and retire expired UI.
  return { store, runtime }
}
```

## Project a current-channel lookup

This opt-in composition uses an independently installed query and source policy.
The runtime must already share the connected live source's durable store and
worker. Project its published input; a current head is not permission to finalize.
A provider needs its complete atomic writer and disclosure guards before offering
this query in production.

```ts compile
// example-id: proposal-current-channel-projection
import type { OutputKnowledge as CurrentChannelRuntime, SourceRequest } from '@bsv/output-knowledge'
import type { LiveLookupSource as CurrentChannelLiveSource } from '@bsv/output-knowledge/sources/live-lookup'
import {
  ProposalChannelHeadsSource,
  ProposalCurrentChannels,
  type ProposalPolicyRegistry as CurrentChannelPolicies,
  type ProposalCurrentChannelSelection,
  type ProposalKnowledgeView as CurrentChannelInput
} from '@bsv/output-knowledge/proposals'

export function attachCurrentChannels(options: {
  runtime: CurrentChannelRuntime
  connected: CurrentChannelLiveSource
  request: SourceRequest
  policies: CurrentChannelPolicies
  reader: string
  selection: ProposalCurrentChannelSelection
}) {
  const { parameters, query } = options.selection
  const source = new ProposalChannelHeadsSource(
    options.connected,
    options.policies,
    parameters,
    query
  )
  const projection = new ProposalCurrentChannels(options.policies, options.reader, [
    options.selection
  ])
  return {
    subscription: options.runtime.attach(source, options.request),
    project: (published: CurrentChannelInput) => projection.project(published)
  }
}
```

## Compose a private channel provider

This Node-only owner atomically maintains private proposal history, the current
lookup feed and retained sessions. Install the corresponding current-channel
query and signed capabilities before accepting traffic. The host still supplies
fresh authorization and its durable external-access guards. Pass the provider
and disclosure companion to the authenticated HTTP router together; drain intake
and physical work before closing the owner. Creation is an explicit installation
choice, never a fallback when opening retained state fails.

```ts compile
// example-id: proposal-private-channel-provider
import {
  SQLiteProposalChannelStore as PrivateChannelStorage,
  type SQLiteProposalChannelStoreOptions as PrivateChannelStorageOptions
} from '@bsv/output-knowledge/proposals/channels-sqlite'
import {
  LookupProviderService as PrivateChannelProvider,
  LookupResponseDisclosure as PrivateChannelDisclosure,
  type LookupProviderContracts as PrivateChannelContracts,
  type LookupProviderOptions as PrivateChannelProviderOptions,
  type LookupResponseDisclosureOptions as PrivateChannelDisclosureOptions
} from '@bsv/output-knowledge/lookup'

export function createPrivateChannelProvider(options: {
  installation: 'create' | 'open'
  storage: PrivateChannelStorageOptions
  contracts: PrivateChannelContracts
  policy: { id: string; digest: string }
  authorize: PrivateChannelProviderOptions['authorize']
  authorizeControl: PrivateChannelDisclosureOptions['authorizeControl']
}) {
  const owner =
    options.installation === 'create'
      ? PrivateChannelStorage.create(options.storage)
      : PrivateChannelStorage.open(options.storage)
  const authorize: PrivateChannelProviderOptions['authorize'] = async (input, signal) => {
    const current = await options.authorize(input, signal)
    const guarded = await owner.authorizeLookup(options.policy, {
      ...current,
      principal: input.principal
    })
    return { access: guarded.access, guards: guarded.guards }
  }
  const shared = { sessions: owner.sessions, contracts: options.contracts, authorize }
  return {
    owner,
    // Use this same journal for put, finalization, recovery and maintenance.
    journal: owner.journal,
    provider: new PrivateChannelProvider({
      ...shared,
      index: owner.feed,
      now: () => options.storage.now()
    }),
    disclosure: new PrivateChannelDisclosure({
      ...shared,
      authorizeControl: options.authorizeControl
    })
  }
}
```

## Compose verified private publication

Create or reopen the protected seller/chain domain explicitly using its retained
index and payload custody. This Node-only composition accepts an already opened
owner; opening missing storage must fail instead of creating a fresh obligation
namespace. The installed validator must authorize the publisher and prove the
schema and key/content relationship. The selected immutable chain view and its
currentness policy remain explicit host inputs.

```ts compile
// example-id: verified-private-publication-service
import type { Engine as PublicationEngine } from '@bsv/overlay'
import { OverlayPrivatePublicationAdmission as PublicationAdmission } from '@bsv/overlay/private-publication-admission'
import {
  PrivateServiceDomain as PublicationDomain,
  PrivatePublicationContracts as PublicationContracts,
  PrivatePublicationAccess as PublicationAccess,
  PrivatePublicationVerificationLeases as PublicationLeases,
  PrivatePublicationCoordinator as PublicationCoordinator,
  PrivatePublicationDisclosure as PublicationDisclosure,
  PrivatePublicationWork as PublicationWork,
  PrivatePublicationReconciler as PublicationReconciler,
  SQLitePrivatePublicationStore as PublicationStore,
  type PrivatePublicationCoordinatorOptions as PublicationOptions,
  type PrivatePublicationInstallation as PublicationInstallation,
  type PrivatePublicationTrust as PublicationTrust
} from '@bsv/output-knowledge/private/node'

export function composePrivatePublication(options: {
  domain: PublicationDomain
  engine: PublicationEngine
  installation: PublicationInstallation
  trust: PublicationTrust
  storageLimits: ConstructorParameters<typeof PublicationStore>[1]
  evidence: PublicationOptions['evidence']
  validate: PublicationOptions['validate']
  validationPolicy: PublicationOptions['validationPolicy']
  lookup: PublicationOptions['lookup']
  manifest: PublicationOptions['manifest']
  clock: PublicationOptions['clock']
  stagingSeconds: string
  canPublish: ConstructorParameters<typeof PublicationAccess>[2]
  verificationCurrent: ConstructorParameters<typeof PublicationLeases>[0]
  workerCurrent: () => boolean
  authorizeControl: NonNullable<ConstructorParameters<typeof PublicationDisclosure>[5]>
}) {
  const contracts = new PublicationContracts(options.installation, options.trust)
  const access = new PublicationAccess(
    options.domain,
    options.installation.topic,
    options.canPublish,
    options.storageLimits.supportedExtensions
  )
  const leases = new PublicationLeases(options.verificationCurrent, {
    supportedExtensions: options.storageLimits.supportedExtensions
  })
  const admission = new PublicationAdmission({
    engine: options.engine,
    identity: options.installation.seller,
    topic: options.installation.topic,
    service: options.installation.service,
    rulesDigest: options.installation.rulesDigest,
    maximumPrivateBytes: options.installation.maximumPrivateBytes,
    maximumOutcomeBytes: 4096,
    publicAdmissionReuse: 'disabled',
    isCurrent: reference => leases.isCurrent(reference)
  })
  const store = new PublicationStore(options.domain, options.storageLimits, {
    contracts,
    validationPolicy: options.validationPolicy,
    lookup: options.lookup,
    maximumBindingBytes: 8192,
    maximumOutcomeBytes: admission.maximumOutcomeBytes
  })
  const worker = new PublicationWork(
    options.domain,
    contracts,
    options.clock,
    options.workerCurrent
  )
  const coordinator = new PublicationCoordinator({
    store,
    contracts,
    access,
    leases,
    admission,
    worker,
    evidence: options.evidence,
    validate: options.validate,
    validationPolicy: options.validationPolicy,
    lookup: options.lookup,
    manifest: options.manifest,
    clock: options.clock,
    stagingSeconds: options.stagingSeconds,
    supportedExtensions: options.storageLimits.supportedExtensions
  })
  const disclosure = new PublicationDisclosure(
    options.domain,
    store,
    contracts,
    access,
    options.clock,
    options.authorizeControl
  )
  return {
    coordinator,
    disclosure,
    reconciler: new PublicationReconciler(coordinator)
  }
}
```

The Engine must use retained admission-history storage and the same installed
topic/rules context. Public history reuse is explicitly disabled in this example.
Start reconciliation only after installation, observe its returned `done`
promise, and stop and await the loop before draining `coordinator.stop()` and
closing the protected domain. A request timeout does not release a still-running
admission operation's physical capacity. Publication readiness is separate from
paid lookup, purchase/POTATOES and permission to release a decryption key.

## Mount private publication over authenticated HTTP

Mount this router before body parsers, compression and response transformations.
Pass the origin's existing BRC-103/104 authentication middleware; do not create a
second authentication session manager at the same origin. The service and
disclosure must refer to the same durable publication owner. Advertise only the
matching installed BRC-101 publication capability.

```ts compile
// example-id: private-publication-http-composition
import {
  createPrivatePublicationRouter,
  type PrivatePublicationRouteOptions
} from '@bsv/overlay-express/private-publication'

export function privatePublicationHTTP(options: PrivatePublicationRouteOptions) {
  return createPrivatePublicationRouter({
    ...options,
    // Smaller deployment bounds may be supplied; this is the profile envelope maximum.
    maximumRequestBytes: options.maximumRequestBytes ?? 4 * 1024 * 1024
  })
}
```

The concrete base URL determines the `/overlay/v1/private/publish` and
`/overlay/v1/private/status` paths below its pathname. For a root base URL,
these are root-relative paths. The caller must sign the exact capability/profile
headers. Default CORS remains credential-free and cross-domain; an explicit
origin list is deployment policy. The router never installs a payment handler or
returns protected material. Its final guard checks the signed response bytes,
original selector, current publisher and native record state after signing.

## Private acquisition host

Install the original-obligation domain, release policy, native wallet and custody
ports explicitly before composing the HTTP host. This helper preserves the
application’s storage and worker lifecycle ownership. See
[acquisition and recovery](./private-acquisition-recovery.md) for wire limits,
shutdown and retry behavior.

```ts compile
// example-id: private-acquisition-host
import AcquisitionHost from '@bsv/overlay-express'
import {
  PrivateAcquisitionCoordinator as AcquisitionCoordinator,
  PrivateAcquisitionDisclosure as AcquisitionDisclosure,
  type PrivateAcquisitionCoordinatorOptions as AcquisitionCoordinatorOptions,
  type PrivateServiceDomain as AcquisitionCustody
} from '@bsv/output-knowledge/private/node'

export function installAcquisition(
  host: AcquisitionHost,
  custody: AcquisitionCustody,
  options: AcquisitionCoordinatorOptions,
  authorizeControl: (buyer: string) => boolean
) {
  const coordinator = new AcquisitionCoordinator(options)
  const disclosure = new AcquisitionDisclosure(
    custody,
    options.store,
    options.contracts,
    options.access,
    options.clock,
    authorizeControl
  )
  const installed = options.contracts.configuration()
  host.configurePrivateAcquisition({
    identity: installed.seller,
    baseURL: installed.baseURL,
    service: coordinator,
    disclosure
  })
  return coordinator
}
```

## Explicit selected-host paid lookup

The caller has already durably retained the original selection, Acquire and
challenge. This example proves public types compose for one recovery operation;
it does not initialize a new quote or construct another payment.

```ts compile
// example-id: explicit-paid-lookup-recovery
import {
  OutputPaidLookupTransport,
  type OutputCapabilityRecoveryRequest,
  type WalletInterface as PaidLookupWallet
} from '@bsv/sdk'

function recoverOriginalAcquisition(
  contract: unknown,
  trust: OutputCapabilityRecoveryRequest,
  request: unknown,
  challenge: unknown,
  wallet: PaidLookupWallet
) {
  return new OutputPaidLookupTransport({
    operation: 'recover',
    contract,
    trust,
    request,
    challenge,
    wallet
  }).send()
}
void recoverOriginalAcquisition
```

## Selected-wallet protected browser control state

Production callers provide the original wallet and identity. The public binding
contains no private request, and explicit initialization is separate from reopen.
The small control cell is not a complete large delivered-result store.

```ts compile
// example-id: protected-operation-control
import { IndexedDBOperationStateStore } from '@bsv/output-knowledge/operations'
import type { WalletInterface as ProtectedControlWallet } from '@bsv/sdk'
import {
  ProtectedOperationStateStore,
  WalletProtectedOperationPayload,
  protectedOperationBinding,
  PROTECTED_OPERATION_INITIAL
} from '@bsv/output-knowledge/operations/protected'

async function openProtectedControl(
  wallet: ProtectedControlWallet,
  originalIdentity: string,
  create: boolean
) {
  const codec = new WalletProtectedOperationPayload(wallet, originalIdentity, 65536)
  const options = { binding: { operation: 'original-operation' }, maximumValueBytes: 60000 }
  const binding = protectedOperationBinding(options, codec)
  const base = create
    ? await IndexedDBOperationStateStore.create(
        'private-control',
        'buyer',
        binding,
        PROTECTED_OPERATION_INITIAL
      )
    : await IndexedDBOperationStateStore.open('private-control', 'buyer', binding)
  return create
    ? await ProtectedOperationStateStore.initialize(base, codec, options, { phase: 'selected' })
    : await ProtectedOperationStateStore.open(base, codec, options)
}
void openProtectedControl
```

## Current authority for an original noSend transaction

The callback checks current authority each time it is invoked. A retained final
is returned after expiry without another signature. A lost reply requires status
recovery of the same operation; it does not authorize replacement construction.

```ts compile
// example-id: original-signing-authority
import type { CreateActionArgs, SignActionArgs } from '@bsv/sdk'
import type { RecoverableActionController as OriginalActionController } from '@bsv/wallet-toolbox/out/src/signer/actionRecovery/RecoverableActionController'

async function finalizeOriginal(
  actions: OriginalActionController,
  operationId: string,
  original: CreateActionArgs,
  signing: SignActionArgs,
  payableUntil: bigint,
  now: () => bigint,
  authorized: () => boolean
) {
  return await actions.finalize(operationId, original, signing, () => {
    if (now() >= payableUntil || !authorized())
      throw new Error('Original signing authority expired')
  })
}
void finalizeOriginal
```

## Immutable original-operation objects

Install the original backend and custody explicitly. Retain separate identities
and role bindings for original requests, selected contracts and results. Reserve
all promised objects before allowing a financial effect. This example establishes
local retention only; validation, usability and payment remain separate.

```ts compile
// example-id: immutable-operation-objects
import type { WalletInterface as ObjectCustodyWallet } from '@bsv/sdk'
import { WalletProtectedOperationPayload as ObjectWalletPayload } from '@bsv/output-knowledge/operations/protected'
import {
  IndexedDBProtectedOperationObjectStore,
  type ProtectedOperationObjectConfiguration as ObjectStoreConfiguration
} from '@bsv/output-knowledge/operations/objects'
import {
  SQLiteProtectedOperationObjectStore,
  NodeProtectedPayloadCodec as ObjectNodePayload
} from '@bsv/output-knowledge/operations/objects/sqlite'

async function openBrowserOriginalObjects(
  name: string,
  original: ObjectStoreConfiguration,
  wallet: ObjectCustodyWallet,
  create: boolean
) {
  const custody = new ObjectWalletPayload(wallet, original.recipient)
  return create
    ? await IndexedDBProtectedOperationObjectStore.create(name, original, custody)
    : await IndexedDBProtectedOperationObjectStore.open(name, original, custody)
}
function openNativeOriginalObjects(
  path: string,
  original: ObjectStoreConfiguration,
  custody: ObjectNodePayload,
  create: boolean
) {
  return create
    ? SQLiteProtectedOperationObjectStore.create(path, original, custody)
    : SQLiteProtectedOperationObjectStore.open(path, original, custody)
}
void openBrowserOriginalObjects
void openNativeOriginalObjects
```

## One original private acquisition

Initialize only an explicitly selected new operation. Reopen existing owners for
status recovery; an unknown reply must not select a new seller or wallet action.
The supplied validation policy independently checks evidence and material.

```ts compile
// example-id: durable-private-lookup-buyer
import {
  PrivateLookupBuyer as DurablePrivateBuyer,
  privateLookupBuyerBinding as durableBuyerBinding,
  type PrivateLookupBuyerOptions as DurableBuyerOptions
} from '@bsv/output-knowledge/private/buyer'

async function openOriginalPrivateBuyer(options: DurableBuyerOptions, create: boolean) {
  const originalBinding = durableBuyerBinding(options)
  const buyer = create
    ? await DurablePrivateBuyer.initialize(options)
    : await DurablePrivateBuyer.open(options)
  return { originalBinding, buyer }
}
async function useOriginalPrivateBuyer(buyer: DurablePrivateBuyer, explicitlyAuthorize: boolean) {
  const originalStatus = explicitlyAuthorize ? await buyer.advance() : await buyer.recover()
  if (originalStatus?.status !== 'delivered') return undefined
  if ((await buyer.validate()) !== 'usable') return undefined
  return await buyer.usableResult()
}
void openOriginalPrivateBuyer
void useOriginalPrivateBuyer
```

## Durable original covenant purchase buyer

The original protected owners are created with the computed installation binding
before initialization. A local recoverable native wallet owner is supplied
explicitly. These types compose transport, payment and independent validation;
compilation does not establish those owners' runtime or chain premises.

```ts compile
// example-id: durable-private-purchase-buyer
import {
  PrivatePurchaseBuyer as CovenantBuyer,
  privatePurchaseBuyerBinding as covenantBuyerBinding,
  type PrivatePurchaseBuyerOptions as CovenantBuyerOptions
} from '@bsv/output-knowledge/private/purchase-buyer'
import {
  WalletToolboxPurchasePayment as CovenantPayment,
  type WalletToolboxPurchasePaymentOptions as CovenantPaymentOptions
} from '@bsv/output-knowledge/private/purchase-wallet'

function installNativeCovenantPayment(options: CovenantPaymentOptions) {
  return new CovenantPayment(options)
}
async function openOriginalCovenantBuyer(options: CovenantBuyerOptions, create: boolean) {
  const binding = covenantBuyerBinding(options)
  const buyer = create ? await CovenantBuyer.initialize(options) : await CovenantBuyer.open(options)
  return { binding, buyer }
}
async function useOriginalCovenantBuyer(buyer: CovenantBuyer, explicitlyAuthorize: boolean) {
  const envelope = explicitlyAuthorize ? await buyer.advance() : await buyer.recover()
  if (envelope?.result.status !== 'delivered') return undefined
  if ((await buyer.validate()) !== 'usable') return undefined
  return buyer.usableResult()
}
void installNativeCovenantPayment
void openOriginalCovenantBuyer
void useOriginalCovenantBuyer
```

## One finite authenticated original purchase exchange

The caller has already retained the original selected contract and exact request.
This opt-in client performs no automatic HTTP payment or wallet action. The
durable buyer above should normally own its lifecycle and retries.

```ts compile
// example-id: finite-private-purchase-transport
import {
  OutputPurchaseTransport as CovenantPurchaseHTTP,
  type OutputPurchaseTransportOptions as CovenantPurchaseHTTPOptions
} from '@bsv/sdk'

async function sendOriginalCovenantPreparation(
  options: CovenantPurchaseHTTPOptions<'prepare'>,
  signal: AbortSignal
) {
  return new CovenantPurchaseHTTP(options).send(signal)
}
async function recoverOriginalCovenantDelivery(
  options: CovenantPurchaseHTTPOptions<'recover'>,
  signal: AbortSignal
) {
  return new CovenantPurchaseHTTP(options).send(signal)
}
void sendOriginalCovenantPreparation
void recoverOriginalCovenantDelivery
```

## Prepared purchase verification

The independently selected seller, original request/terms and trusted chain view
remain caller-owned selections. This read-only verifier does not fund, admit or
release anything.

```ts compile
// example-id: revenue-listing-purchase
import { RevenueListing as PurchaseListingCodec } from '@bsv/sdk/script/templates/RevenueListing'
import type {
  OutputPurchasePrepare,
  OutputSignedPurchaseTerms as PreparedPurchaseTerms
} from '@bsv/sdk'
import {
  RevenueListingPurchaseVerifier,
  type ChainViewResolver as PurchaseChainViewResolver,
  type VerificationContext as PurchaseVerificationContext
} from '@bsv/output-knowledge/revenue-listing'

export function installPurchaseVerifier(program: Uint8Array, chains: PurchaseChainViewResolver) {
  return new RevenueListingPurchaseVerifier(new PurchaseListingCodec(program), chains, {
    concurrentRequests: 2
  })
}

export async function inspectPreparedPurchase(
  verifier: RevenueListingPurchaseVerifier,
  purchase: unknown,
  original: {
    seller: string
    request: OutputPurchasePrepare
    terms: PreparedPurchaseTerms
  },
  context: PurchaseVerificationContext,
  signal: AbortSignal
) {
  return await verifier.verify(purchase, original, context, signal)
}
```

## Original native purchase preparation

The installed domain verifies the listing, domain and private readiness before
this reservation. An independently selected signer signs the frozen body. This
example reserves original custody and enqueues payable terms; it does not fund,
admit or release a purchase. The caller supplies current authenticated authority
to the native guard and separately signs the complete HTTP response.
The explicit native clock installer below is for a new installation; existing
custody must retain its original profile. The prepared local record example
exercises the public domain's synchronous transaction view and performs no
external effect.

```ts compile
// example-id: original-private-purchase-custody
import type { OutputSignedPurchaseTerms as OriginalPurchaseTerms } from '@bsv/sdk'
import {
  PrivatePurchaseContracts as OriginalPurchaseContracts,
  SQLitePrivatePurchaseStore as OriginalPurchaseStore,
  type PrivatePurchasePreparedContract as OriginalPreparedPurchase,
  type PrivatePurchaseCustody as OriginalPurchaseCustody,
  type ProtectedLedgerGuard as OriginalPurchaseGuard,
  type PrivatePurchaseStoreLimits as OriginalPurchaseLimits,
  type PrivateServiceDomain as OriginalPurchaseDomain
} from '@bsv/output-knowledge/private/node'

export function installNativeObservedPurchaseStore(
  domain: OriginalPurchaseDomain,
  contracts: OriginalPurchaseContracts,
  limits: OriginalPurchaseLimits,
  policy: OriginalPurchaseCustody['validationPolicy']
) {
  return new OriginalPurchaseStore(domain, contracts, limits, policy, 'native-observation-v1')
}

export function commitObservedLocalRecord(
  domain: OriginalPurchaseDomain,
  expectedRevision: string,
  key: string,
  clock: () => string,
  guard: OriginalPurchaseGuard
) {
  return domain.ledger.commitPrepared(
    expectedRevision,
    view => [
      {
        kind: 'rules',
        key,
        expectedRevision: null,
        reservedBytes: 1024,
        reservedUpdates: 0,
        value: { observedAt: view.observedAt }
      }
    ],
    clock,
    guard
  )
}

export function reserveOriginalPurchase(
  store: OriginalPurchaseStore,
  contracts: OriginalPurchaseContracts,
  prepared: OriginalPreparedPurchase,
  signedTerms: OriginalPurchaseTerms,
  custody: Omit<OriginalPurchaseCustody, 'original'>,
  clock: () => string,
  guard: OriginalPurchaseGuard
) {
  const original = contracts.authenticate(prepared, signedTerms)
  return store.prepare({ ...custody, original }, clock, guard).progress.acquisitionId
}

export function enqueueOriginalPayableTerms(
  store: OriginalPurchaseStore,
  acquisitionId: string,
  authenticatedRecipient: string,
  clock: () => string,
  guard: OriginalPurchaseGuard,
  send: (terms: OriginalPurchaseTerms) => void
) {
  const retained = store.load(acquisitionId, authenticatedRecipient, clock, guard)
  if (!retained) throw new Error('Original purchase is unavailable')
  store.discloseTerms(retained, authenticatedRecipient, clock, guard, send)
}
```

## Original purchase coordination and physical private disclosure

These installed ports compose the durable native owner. The caller must supply real
domain and release verification; compiling the composition does not establish their
premises or activate an endpoint.

```ts compile
// example-id: private-purchase-coordination
import {
  PrivatePurchaseCoordinator,
  PrivatePurchaseAccess,
  PrivatePurchaseDisclosure,
  SQLitePrivatePurchaseEvidence,
  type PrivatePurchaseEvidenceLimits,
  type PrivatePurchaseCoordinatorOptions,
  type PrivateServiceDomain,
  type ProtectedLedgerView
} from '@bsv/output-knowledge/private/node'
import type { OutputPurchasePrepare as CoordinatedPurchasePrepare } from '@bsv/sdk'

function installPurchase(
  custody: PrivateServiceDomain,
  options: Omit<PrivatePurchaseCoordinatorOptions, 'access' | 'evidence'>,
  permission: (
    request: CoordinatedPurchasePrepare,
    buyer: string,
    mode: 'initial' | 'retained',
    view: ProtectedLedgerView
  ) => boolean,
  controlPermission: (buyer: string) => boolean,
  evidenceLimits: PrivatePurchaseEvidenceLimits
) {
  const access = new PrivatePurchaseAccess(
    custody,
    options.contracts.configuration().topic,
    permission
  )
  const evidence = new SQLitePrivatePurchaseEvidence(custody, options.contracts, evidenceLimits)
  const coordinator = new PrivatePurchaseCoordinator({ ...options, access, evidence })
  const disclosure = new PrivatePurchaseDisclosure(
    custody,
    options.store,
    options.contracts,
    access,
    options.clock,
    controlPermission
  )
  return { coordinator, disclosure, stop: () => coordinator.stop() }
}
export { installPurchase }
```

## Selected-host covenant admission and HTTP companions

The Engine companion receives only public transaction bytes. Its caller supplies
independent original-domain validation and native intent checks. The optional HTTP
router uses the same current physical disclosure owner and charges no HTTP fee.

```ts compile
// example-id: selected-host-purchase-companions
import type { Engine as PurchaseEngine } from '@bsv/overlay'
import { OverlayPurchaseAdmission } from '@bsv/overlay/purchase-admission'
import {
  createPrivatePurchaseRouter,
  type PrivatePurchaseRouteOptions
} from '@bsv/overlay-express/private-purchase'
import type { PrivatePurchaseAdmission } from '@bsv/output-knowledge/private/node'
import type { OutputCapabilityRequest } from '@bsv/sdk'

function purchaseAdmission(
  engine: PurchaseEngine,
  identity: string,
  baseURL: string,
  topic: string,
  rulesDigest: string,
  rules: OutputCapabilityRequest['rules']
): PrivatePurchaseAdmission {
  return new OverlayPurchaseAdmission({
    engine,
    identity,
    baseURL,
    topic,
    rulesDigest,
    rules,
    domainProfile: 'https://bsv.brc.dev/tokens/0197#listing-purchase-v1',
    admittedOutputIndex: 0
  })
}
const purchaseRoutes = (options: PrivatePurchaseRouteOptions) =>
  createPrivatePurchaseRouter(options)
export { purchaseAdmission, purchaseRoutes }
```

## Standing Offer consent and original recovery promise

This optional LCH adapter checks terms before constructing a wallet action.
Its caller must install independent lineage, purchase, role and release
verification before payment, licensing or playback.

```ts compile
// example-id: lch-standing-offer-terms
import {
  validateLCHOverlayCovenantTerms,
  validateLCHOverlayCovenantWindow,
  validateLCHOverlayCovenantPromise,
  type LCHOverlayCovenantTermsInput
} from '@bsv/lch/overlay-acquisition'
import type { OutputSignedPurchaseTerms as StandingPurchaseTerms } from '@bsv/sdk'

async function checkStandingOffer(
  input: LCHOverlayCovenantTermsInput,
  originalTerms: StandingPurchaseTerms,
  now: string
) {
  const terms = await validateLCHOverlayCovenantTerms(input)
  validateLCHOverlayCovenantWindow(terms, originalTerms, now)
  return {
    terms,
    original: validateLCHOverlayCovenantPromise(terms, originalTerms)
  }
}
export { checkStandingOffer }
```

## Protected covenant entitlement and explicit playback

The independently installed proof ports must execute complete original lineage,
purchase Script and selected release checks. The application owns ciphertext,
wallet access and protected native or browser custody. This composition never
constructs or pays for a transaction.

```ts compile
// example-id: lch-covenant-buyer-entitlement
import {
  LCHOverlayCovenantDomain,
  type LCHOverlayCovenantDomainOptions,
  type LCHOverlayObjectCustody
} from '@bsv/lch/overlay-covenant'
import type {
  OutputSignedPurchaseTerms as ContentPurchaseTerms,
  OutputPurchaseSubmit as ContentPurchaseSubmission,
  OutputPurchaseEnvelope as ContentPurchaseDelivery
} from '@bsv/sdk'

async function openCovenantEntitlement(
  options: LCHOverlayCovenantDomainOptions,
  retained: { id: string; original: Uint8Array },
  objects: LCHOverlayObjectCustody
) {
  return LCHOverlayCovenantDomain.open(options, retained, objects)
}
async function verifyAndPlayCovenantContent(
  domain: LCHOverlayCovenantDomain,
  original: LCHOverlayCovenantDomainOptions['original'],
  terms: ContentPurchaseTerms,
  submission: ContentPurchaseSubmission,
  delivered: ContentPurchaseDelivery,
  signal: AbortSignal
) {
  await domain.verify(original.prepare, terms, submission, delivered, signal)
  return domain.playback(delivered, signal)
}
export { openCovenantEntitlement, verifyAndPlayCovenantContent }
```

## Pure covenant seller with protected coordinator custody

The seller adapter verifies the installed full purchase and release boundaries.
It receives exact retained BEEF from the coordinator during issuance. Wallet,
topic admission and first-result byte retention stay in their respective owners.

```ts compile
// example-id: lch-covenant-seller-domain
import {
  LCHOverlayCovenantSeller,
  type LCHOverlayCovenantSellerOptions
} from '@bsv/lch/overlay-covenant'
import type { PrivatePurchaseDomain as ProtectedCovenantDomainPort } from '@bsv/output-knowledge/private/node'

function installCovenantContentSeller(
  options: LCHOverlayCovenantSellerOptions
): ProtectedCovenantDomainPort {
  return new LCHOverlayCovenantSeller(options)
}
export { installCovenantContentSeller }
```

## Compound native root and lookup response fence

The lookup session owner enters its native gate first. Its synchronous send
callback enters the root decision gate, keeping both owners current through
physical enqueue. Projection never acquires those gates in reverse order.

```ts compile
// example-id: native-root-lookup-disclosure
import { LookupResponseDisclosure } from '@bsv/output-knowledge/lookup'
import {
  RootAdvertisementServing,
  RootLookupServingDisclosure,
  type RootAdvertisementServingGate
} from '@bsv/output-knowledge/root-eviction/serving'

function composeRootLookup(
  provider: LookupResponseDisclosure,
  journal: RootAdvertisementServingGate,
  authorize: (identity: string, kind: 'data' | 'control') => boolean
) {
  return new RootLookupServingDisclosure({
    disclosure: provider,
    serving: new RootAdvertisementServing(journal),
    authorize
  })
}
void composeRootLookup
```

## Explicit public history storage

The new options preserve default current-output reads. A historical GASP reader
must use the exact installed storage port; it does not grant lookup visibility.

```ts compile
// example-id: retained-public-beef-history
import type {
  Engine as PublicHistoryEngine,
  StorageScope as PublicHistoryScope
} from '@bsv/overlay'
import { MongoOverlayStorage } from '@bsv/overlay/storage/mongo/MongoOverlayStorage'
import { OverlayGASPStorage } from '@bsv/overlay/GASP/OverlayGASPStorage.ts'

function publicHistoryStorage(
  db: ConstructorParameters<typeof MongoOverlayStorage>[0],
  scope: PublicHistoryScope
) {
  return new MongoOverlayStorage(db, scope, {
    retainAdmissionHistory: true,
    retainedBEEF: { maximumBytes: 4194304 }
  })
}
function publicHistorySync(topic: string, engine: PublicHistoryEngine) {
  return new OverlayGASPStorage(topic, engine, undefined, undefined, {
    historicalOutputs: true
  })
}
export { publicHistoryStorage, publicHistorySync }
```

## Recipient-authorized primitive lookup context

Use the original protected publication and a transport-authenticated caller.
Request-local hydration and the final native disclosure remain separate steps.

```ts compile
// example-id: protected-publication-context-reader
import {
  PrivatePublicationLookupContext as ProtectedContextLookup,
  type PrivatePublicationLookupCaller as ProtectedContextCaller,
  type PrivatePublicationLookupContextOptions as ProtectedContextOptions
} from '@bsv/output-knowledge/private/node'

function recipientContext(
  installation: ProtectedContextOptions,
  publicationId: string,
  authenticatedCaller: ProtectedContextCaller
) {
  const reader = new ProtectedContextLookup(installation)
  const prepared = reader.prepare(publicationId, authenticatedCaller)
  return {
    formula: prepared.formula(),
    bindHydratedAnswer: (answer: unknown) => prepared.bind(answer),
    dispose: () => prepared.dispose()
  }
}
export { recipientContext }
```

## Purchase commitments and historical release

An installed domain must independently verify the exact historical transaction,
including every Script, receipt and complete lineage, before this binding step.
Current-alias BEEF remains separate evidence requiring its own domain and chain
assessment; it cannot replace the historical signed release.

```ts compile
// example-id: purchase-commitment-historical-release
import {
  Transaction as HistoricalPurchaseTransaction,
  verifyOutputPurchaseEnvelope as bindHistoricalPurchaseEnvelope,
  type OutputSignedPurchaseTerms as HistoricalPurchaseTerms
} from '@bsv/sdk'
import { revenueListingPurchaseCommitment as historicalPurchaseCommitment } from '@bsv/sdk/script/templates/RevenueListingSpend'
import { revenueListingChildPublicKey as deriveHistoricalSellerChild } from '@bsv/sdk/script/templates/RevenueListing'

export function bindHistoricalPurchase(
  domainVerifiedHistoricalTransaction: HistoricalPurchaseTransaction,
  originalTerms: HistoricalPurchaseTerms,
  authenticatedEnvelope: unknown
) {
  const commitment = historicalPurchaseCommitment(domainVerifiedHistoricalTransaction)
  const envelope = bindHistoricalPurchaseEnvelope(
    authenticatedEnvelope,
    originalTerms,
    domainVerifiedHistoricalTransaction.id('hex'),
    commitment
  )
  return {
    envelope,
    commitment,
    publicSellerChild: deriveHistoricalSellerChild(originalTerms.body.seller)
  }
}
```

This pure step neither funds nor signs and does not establish secret usability.
The complete replacement Script, wallet, alias-recovery and LCH compositions
remain distinct checkpoint requirements.

## Independently verified covenant commitment

The optional LCH covenant proof port returns the full digest only after the
installed transaction domain succeeds. Its guard remains tied to the selected
chain and authorization context. This adapter neither calculates truth from a
remote claimed digest nor creates an entitlement by itself.

```ts compile
// example-id: independently-verified-lch-commitment
import type { RevenueListingPurchaseResult as LCHCommitmentPurchaseResult } from '@bsv/output-knowledge/revenue-listing'
import type { LCHOverlayVerifiedCovenantPurchase as LCHCommitmentVerifiedPurchase } from '@bsv/lch/overlay-covenant'

export function lchCommitmentFromVerifiedPurchase(
  result: LCHCommitmentPurchaseResult,
  checkCurrent: () => void
): LCHCommitmentVerifiedPurchase {
  if (result.status !== 'verified') throw new Error('Complete purchase verification is required')
  checkCurrent()
  return { purchaseCommitment: result.purchaseCommitment, checkCurrent }
}
```

The replacement exemplar's portable codec takes both frozen programs and makes
the stage choice explicit. Genesis creates the activation stage; a complete,
independently validated activation transaction must precede use of the active
stage. This codec checks bytes and descriptor metadata. It establishes neither
that history nor a purchase right. The legacy planner and lineage integration
remain pending in the current alignment record.

```ts compile
// example-id: immutable-two-stage-listing-codec
import { RevenueListingProfile } from '@bsv/sdk/script/templates/RevenueListingProfile'

export function encodeImmutableListingStages(
  activationProgram: Uint8Array,
  activeProgram: Uint8Array,
  descriptor: unknown
) {
  const profile = new RevenueListingProfile(activationProgram, activeProgram)
  const activation = profile.lock('activation', descriptor)
  const active = profile.lock('active', descriptor)
  return {
    activation,
    active,
    checkedActivation: profile.decode(activation.toBinary(), descriptor),
    checkedActive: profile.decode(active.toBinary(), descriptor)
  }
}
```
