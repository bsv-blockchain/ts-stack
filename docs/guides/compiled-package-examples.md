---
id: compiled-package-examples
title: 'Compiled Package Boundary Examples'
kind: guide
version: '1.0.0'
last_updated: '2026-07-27'
last_verified: '2026-07-27'
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
import { BsvDid, type DidDocument } from '@bsv/did'
import type { DIDQuery } from '@bsv/overlay-topics'

const exampleDidDocument: DidDocument = BsvDid.toDidDocument(
  BsvDid.fromPublicKey(PrivateKey.fromRandom().toPublicKey().toDER() as number[])
)
const acceptDidLookup = (query: DIDQuery): DIDQuery => query

void exampleDidDocument
void acceptDidLookup
```

The compiler combines all marked fences into one consumer module, so imports
from earlier examples are available here just as they would be in one
application.

## Messaging

```ts compile
// example-id: messaging
import type { MessageBoxClientOptions } from '@bsv/message-box-client'
import type { PublicProfile } from '@bsv/paymail'

const exampleMessageBoxOptions: MessageBoxClientOptions = {
  host: 'https://messagebox.example'
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
