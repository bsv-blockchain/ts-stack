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
