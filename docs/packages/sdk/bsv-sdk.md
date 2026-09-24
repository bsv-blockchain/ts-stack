---
id: bsv-sdk
title: '@bsv/sdk'
kind: package
domain: sdk
version: '2.9.0'
npm: '@bsv/sdk'
last_updated: '2026-09-23'
last_verified: '2026-09-23'
review_cadence_days: 30
status: stable
tags: ['sdk', 'crypto', 'transactions']
repo: 'https://github.com/bsv-blockchain/ts-stack/tree/main/packages/sdk'
---

# @bsv/sdk

The unpublished 2.9 candidate adds bounded BRC-118 payment transport to `AuthFetch` and corrects recipient-side BRC-29 derivation. See the [BRC-118 integration and migration guide](../../guides/brc118-payments.md) for preparation, negotiation, exact-byte authentication and uncertain-payment recovery. Existing nonempty non-multipart signing preimages and the 8 KiB header selection default are preserved.

The included 2.8.3 compatibility fixes repair HTTP wallet discovery with an explicit BRC100
originator and binds the default JSON transport fetch receiver for browsers.
It restores signed `listActions` net amounts with the historical wire encoding,
matching JSON validation; count, length and individual output bounds stay intact.
Apps affected by these client defects can update the SDK without changing calls.
Wallets retain the existing BRC100 contract; an ecosystem-wide application
migration is not required. The 2.9.0 candidate remains unpublished until its protected
release workflow completes.

The action-history compatibility regression affects signed `listActions` values
in the 2.8.x binary processor and client. Updating a wallet repairs responses for
older compatible clients; an application already bundling the affected 2.8.x
binary client also needs the SDK patch. No call or persisted-data change is
needed. Synthetic cross-version checks cover SDK 2.4.0, 2.5.0, 2.7.1, 2.8.1 and
2.8.2 at eight signed/unsigned boundaries: all 40 candidate cases pass, all 32
previously valid cases retain exact response bytes, and the eight known negative
2.8.1/2.8.2 failures are recorded separately. These checks are bounded fixture
evidence, not a claim that every ecosystem application has been tested.

Version 2.8.1 repairs portable decryption of authenticated empty
AES-GCM plaintext. Browser/mobile and native Node envelopes now interoperate
for empty encrypted fields. Encryption bytes and the full authentication tag
remain unchanged. No ciphertext, account-data or API migration is required.
The patch is published through the protected [SDK release](https://github.com/bsv-blockchain/ts-stack/actions/runs/35888747366) from commit `e09515508bf5bf22d7b56085170debc2b0803b2a`, with matching npm integrity and verified provenance.

Version 2.8.0 corrects BUMP offset arithmetic above 32 bits
through `Number.MAX_SAFE_INTEGER`, preserving existing wire encodings. Root
calculation, extraction, combination and trimming use the same exact numeric
domain; malformed non-integer and unsafe offsets fail explicitly. No consumer
migration is needed for this correction.

It also adds `TOTP.generateSecure()` and `TOTP.validateSecure()` for new
authentication flows. These methods default to conventional six-character,
zero-padded codes. The existing `TOTP.generate()` and `TOTP.validate()` methods
retain their published two-digit, unpadded default so existing wire protocols
do not change; applications should preserve secure codes as strings and apply
an independent attempt limit.

The foundational cryptographic and transaction library for the BSV blockchain. Zero external dependencies — all cryptographic primitives have been validated by a third-party auditor. Every other library in the ts-stack builds on top of `@bsv/sdk`. <!-- audio: ts-stack.m4a @ 27:00 -->

Provides low-level primitives (keys, signatures, hashing), script construction and execution, transaction creation and signing, and integration interfaces for wallets and overlay networks.

Security-sensitive consumers require affirmative cryptographic verdicts.
`IdentityClient` will not publish a certificate whose certifier signature is
invalid, and `GlobalKVStore` discards untrusted overlay entries unless their
controller signature verifies as valid.

Authenticated general messages, certificate requests, and certificate
responses are bound to the identity in the nonce-selected peer session.
Transport identity metadata must match that session, and callbacks receive
only the identity used for signature verification.

Completed `createAction` and `signAction` transaction results must evidence
the value of every direct input. A completed `createAction` may rely on the
caller's immutable `inputBEEF`; otherwise the returned BEEF must include each
direct source transaction. Deferred `signableTransaction` results may remain
partial for compatibility, but the final result must be complete. Duplicate
input outpoints and zero-input transactions that create value fail validation.

## Install

```bash
npm install @bsv/sdk
```

## Quick start

```typescript
import { PrivateKey, P2PKH, Transaction } from '@bsv/sdk'

const privKey = PrivateKey.fromWif('L5EY1SbTvvPNSdCYQe1EJHfXCBBT4PmnF6CDbzCm9iifZptUvDGB')
const sourceTransaction = Transaction.fromHex('0200000001...') // Previous tx hex
const recipientAddress = '1EvmsbpAY7nESLkN4ajLTMbvsaQ1HpJPGX'

const tx = new Transaction(
  1,
  [
    {
      sourceTransaction,
      sourceOutputIndex: 0,
      unlockingScriptTemplate: new P2PKH().unlock(privKey)
    }
  ],
  [
    {
      lockingScript: new P2PKH().lock(recipientAddress),
      satoshis: 5000
    },
    {
      lockingScript: new P2PKH().lock(privKey.toAddress()),
      change: true
    }
  ]
)

await tx.fee()
await tx.sign()
const broadcast = await tx.broadcast()
```

## What it provides

- **Cryptographic primitives** — `PrivateKey`, `PublicKey`, `Hash`, `Signature`, `Entropy`, `Curve` (secp256k1)
- **Script building** — `Script`, `LockingScript`, `UnlockingScript`, `ScriptChunk`, `OP` codes
- **Script templates** — `P2PKH` (Pay-to-Public-Key-Hash), `P2PK`, `P2SH`, `PushDrop` for overlay protocols
- **Transaction building** — `Transaction`, `Input`, `Output`, complete builder with signing and broadcasting
- **Fee models** — `SatoshisPerKilobyte`, `LivePolicy` for network-aware fee estimation
- **Network integration** — `ARC`, `WhatsOnChainBroadcaster`, `Teranode` broadcasters; `defaultChainTracker`, `WhatsOnChain`
- **SPV verification** — `MerklePath` for merkle inclusion proofs
- **BEEF envelopes** — `Beef` (BRC-62) for atomic transaction batches with proofs
- **Message signing** — BRC-18 signed messages
- **Wallet interface** — `WalletInterface` (BRC-100), `WalletClient()` factory, `ProtoWallet` for testing
- **Auth & identity** — `Certificate`, `IdentityKey`, `AuthModule` for peer authentication
- **Storage & KV** — `Storage` interface with `LocalStorageAdapter`, `InMemoryStorage`; `KVStore` for distributed data
- **Overlay integration** — `TopicBroadcaster`, `TopicListener`, `RemittanceProtocol`, `IdentityResolver`, `Registry`
- **2FA** — `TOTP.generateSecure()` and `TOTP.validateSecure()` for new flows;
  compatibility methods remain available for existing protocols

## AuthFetch payment ancestry

Recipients can include the optional `x-bsv-payment-known-txids` response
header in a BRC-105 402 challenge to list transactions they already possess
and have validated. `AuthFetch` forwards up to 256 unique lowercase IDs
through the wallet's `createAction` options, including newly created payments
after repricing. Compatible wallets can then omit those ancestors from payment
BEEF. Values are comma-separated 64-character hexadecimal transaction IDs;
whitespace, duplicates, and malformed entries are ignored. An absent or
invalid-only header preserves existing payment behavior, so existing consumers
require no migration. Browser services must expose the optional response header
through their existing CORS policy to enable this optimization.
The header is an optional SDK extension, not a standardized BRC-105 header.

Authenticated HTTP response bodies use a bounded streaming buffer before
signed-message decoding: 16 MiB for application responses and 1 MiB for auth
handshakes by default. `SimplifiedFetchTransportOptions` exposes
`maxResponseBytes` and `maxHandshakeResponseBytes` for explicit deployment
limits. Malformed response frames with excessive headers or lengths,
truncation, or trailing bytes are rejected.

## Common patterns

### Build a P2PKH transaction

```typescript
import { PrivateKey, P2PKH, Transaction } from '@bsv/sdk'

const privKey = PrivateKey.fromWif('L5EY1SbTvvPNSdCYQe1EJHfXCBBT4PmnF6CDbzCm9iifZptUvDGB')
const sourceTransaction = Transaction.fromHex('0200000001...')
const recipientAddress = '1EvmsbpAY7nESLkN4ajLTMbvsaQ1HpJPGX'

const tx = new Transaction(
  1,
  [
    {
      sourceTransaction,
      sourceOutputIndex: 0,
      unlockingScriptTemplate: new P2PKH().unlock(privKey)
    }
  ],
  [
    {
      lockingScript: new P2PKH().lock(recipientAddress),
      satoshis: 5000
    },
    {
      lockingScript: new P2PKH().lock(privKey.toAddress()),
      change: true
    }
  ]
)

await tx.fee()
await tx.sign()
```

### Connect to a BRC-100 wallet

```typescript
import { P2PKH, WalletClient } from '@bsv/sdk'

const wallet = new WalletClient('auto', 'example.com')
const recipientAddress = '1EvmsbpAY7nESLkN4ajLTMbvsaQ1HpJPGX'
const lockingScript = new P2PKH().lock(recipientAddress).toHex()

const { publicKey } = await wallet.getPublicKey({
  identityKey: true
})

const action = await wallet.createAction({
  description: 'Create payment',
  outputs: [
    {
      lockingScript,
      satoshis: 1000,
      outputDescription: 'Payment output'
    }
  ]
})

console.log(publicKey, action.txid)
```

`WalletClient` implements the BRC-100 method surface. It discovers a wallet substrate such as BSV Desktop over localhost or BSV Browser over a postMessage bridge.

`CreateActionResult` can carry AtomicBEEF as either a historical `number[]` or
a binary Wallet Wire `Uint8Array`. BRC-29 remittance accepts both and emits a
portable `number[]` settlement artifact for JSON-safe transport.

For advanced postMessage integrations, `XDM` defaults to the wildcard target
origin so public apps, mobile webviews, and opaque origins can reach an embedded
wallet. Every response must still come from the current parent window and match
the invocation's random request ID. When the wallet parent has a stable known
origin, pass that exact origin to `new XDM('https://wallet.example')` to require
it on both outbound and inbound messages. This transport choice is independent
of CORS and of any CSP applied to an app's documents.

### Verify SPV with merkle proof

```typescript
import { Transaction, WhatsOnChain } from '@bsv/sdk'

const beefHex = [
  '0100beef01fe636d0c0007021400fe507c0c7aa754cef1f7889d5fd395cf1f785dd7de98eed895dbedfe4e5b',
  'c70d1502ac4e164f5bc16746bb0868404292ac8318bbac3800e4aad13a014da427adce3e010b00bc4ff395ef',
  'd11719b277694cface5aa50d085a0bb81f613f70313acd28cf4557010400574b2d9142b8d28b61d88e3b2c3f',
  '44d858411356b49a28a4643b6d1a6a092a5201030051a05fc84d531b5d250c23f4f886f6812f9fe3f402d616',
  '07f977b4ecd2701c19010000fd781529d58fc2523cf396a7f25440b409857e7e221766c57214b1d38c7b481f',
  '01010062f542f45ea3660f86c013ced80534cb5fd4c19d66c56e7e8c5d4bf2d40acc5e010100b121e91836fd',
  '7cd5102b654e9f72f3cf6fdbfd0b161c53a9c54b12c841126331020100000001cd4e4cac3c7b56920d1e7655',
  'e7e260d31f29d9a388d04910f1bbd72304a79029010000006b483045022100e75279a205a547c445719420aa',
  '3138bf14743e3f42618e5f86a19bde14bb95f7022064777d34776b05d816daf1699493fcdf2ef5a5ab1ad710',
  'd9c97bfb5b8f7cef3641210263e2dee22b1ddc5e11f6fab8bcd2378bdd19580d640501ea956ec0e786f93e76',
  'ffffffff013e660000000000001976a9146bfd5c7fbe21529d45803dbcf0c87dd3c71efbc288ac0000000001',
  '000100000001ac4e164f5bc16746bb0868404292ac8318bbac3800e4aad13a014da427adce3e000000006a47',
  '304402203a61a2e931612b4bda08d541cfb980885173b8dcf64a3471238ae7abcd368d6402204cbf24f04b9a',
  'a2256d8901f0ed97866603d2be8324c2bfb7a37bf8fc90edd5b441210263e2dee22b1ddc5e11f6fab8bcd237',
  '8bdd19580d640501ea956ec0e786f93e76ffffffff013c660000000000001976a9146bfd5c7fbe21529d4580',
  '3dbcf0c87dd3c71efbc288ac0000000000'
].join('')

const tx = Transaction.fromHexBEEF(beefHex)
const chainTracker = new WhatsOnChain()

if (await tx.verify(chainTracker)) {
  console.log('This transaction is on chain, proven with SPV.')
}
```

### Encode data on-chain with PushDrop

```typescript
import { PushDrop, Utils, WalletClient } from '@bsv/sdk'

const wallet = new WalletClient('auto', 'example.com')
const pushDrop = new PushDrop(wallet)

const lockingScript = await pushDrop.lock(
  [
    Utils.toArray('myAssetId', 'utf8'),
    Utils.toArray('100', 'utf8'),
    Utils.toArray(JSON.stringify({ name: 'MyToken' }), 'utf8')
  ],
  [2, 'my app token'],
  'asset-1',
  'self',
  true,
  false
)

const output = { lockingScript: lockingScript.toHex(), satoshis: 1 }
```

## Key concepts

- **Private Key** — 256-bit value from which all wallet operations derive. Never exposed in network traffic.
- **Public Key** — Elliptic curve point derived from private key; used for address generation and signature verification.
- **Script** — Combination of operation codes and data that define spending conditions. Locking scripts constrain outputs; unlocking scripts unlock them.
- **Transaction** — Atomic unit of blockchain state change. Inputs reference previous outputs (UTXOs); outputs create new UTXOs.
- **UTXO** — Unspent Transaction Output; identified by (txid, outputIndex). Spending requires a valid unlocking script.
- **Signature** — ECDSA signature with sighash byte indicating which transaction fields are committed to.
- **Merkle Proof** — Proof of inclusion in a block; enables SPV without downloading full blocks.
- **BEEF** — BRC-62 envelope; atomic bundle of transactions with merkle proofs for offline verification.
- **Wallet Interface (BRC-100)** — Standardized interface for wallet RPC between apps and wallet services. Abstracts away key management.
- **Overlay** — Second-layer protocol using on-chain anchors (PushDrop) to build services without blockchain modifications.

## When to use this

- You're building any BSV application that needs to create, sign, or verify transactions
- You need to work with Bitcoin Script or transaction primitives
- You're implementing key management or cryptographic operations
- You want to build SPV-based light clients
- You need to integrate with overlay protocols using PushDrop

## When NOT to use this

- Use [@bsv/wallet-toolbox](../wallet/wallet-toolbox.md) instead if you need full wallet functionality with persistent storage and signing management
- Use [@bsv/btms](../wallet/btms.md) if you're building token issuance/transfer (it abstracts the Script encoding)
- Use [@bsv/wallet-relay](../wallet/wallet-relay.md) if you need mobile-to-desktop wallet pairing

## Spec conformance

- **BRC-18** — Signed messages
- **BRC-29** — Bitcoin Envelope (UTXO-addressed messages)
- **BRC-42, BRC-43** — Key derivation protocols
- **BRC-62** — BEEF (transaction envelope format)
- **BRC-100** — Wallet interface standard
- **SPV** — Full merkle proof verification support
- **Bitcoin Script** — Full consensus-rule-compliant interpreter

## Common pitfalls

> **Sighash commit mismatch** — Unlocking script hash commits only to parts of the transaction. If you modify tx after signing, signature becomes invalid. Always sign last.

> **Fee estimation timing** — `tx.fee()` may vary if mempool conditions change. Estimate early and buffer for volatility, or use live fee trackers.

> **UTXO reuse across parallel transactions** — If two transactions reference the same UTXO, only one will confirm. Wallet implementations must track pending outputs.

> **AuthFetch payment authority** — Automatic BRC-105 payment creation delegates
> spending authorization to the configured wallet's `createAction` policy. Use
> a wallet that requires the intended user or policy approval. Diagnostics omit
> URL credentials/path/query, sensitive header values, transaction bytes, and
> derivation material.

> **Script evaluation order** — Unlocking script is evaluated first, then locking script. Stack must be left with true atop for success.

> **Broadcast endpoint differences** — ARC, WhatsOnChain, Teranode have different response formats and rate limits. Implement retry logic and fallback chains.

## Related packages

- [@bsv/wallet-toolbox](../wallet/wallet-toolbox.md) — Complete wallet implementation with storage and signing
- [@bsv/btms](../wallet/btms.md) — Token issuance and transfer
- [@bsv/wallet-relay](../wallet/wallet-relay.md) — Mobile wallet pairing

## Reference

- [API reference (TypeDoc)](https://bsv-blockchain.github.io/ts-stack/api/sdk/)
- [Source on GitHub](https://github.com/bsv-blockchain/ts-stack)
- [npm](https://www.npmjs.com/package/@bsv/sdk)

## Certificate policy and observer callbacks

SDK 2.7 records the locally requested certificate policy for each BRC-103
session. Standalone responses must fit one complete locally recorded dynamic
request allowlist or the session's handshake allowlist. Policies are copied
before sending, so a later edit of the caller's object does not change
validation. Responses never select their own validation policy. A different
dynamic request cannot satisfy an unmet handshake requirement.

The legacy v0.1 `RequestedCertificateSet` has no all-of, any-of, threshold, or
optional-field expression. Compatibility validation therefore proves only that
each supplied certificate and each non-empty disclosed-field subset is allowed
by one locally recorded set. It does **not** prove that every listed certificate
type or every requested field was supplied. Each party chooses what to request,
what to provide, and how much to disclose. Before granting access, inspect the
actual certificate types, certifiers, and decrypted fields and enforce the
application's complete authorization policy. Terminate or constrain the
session or operation when the disclosures are insufficient; protocol-level
authentication never declares the claims sufficient for the application.

The v0.1 AuthMessage fields, signatures and encodings are unchanged. Because a
certificateResponse does not echo the request nonce, concurrent responses are
matched against complete local requested sets, not individual request IDs. A
successful dynamic response consumes one matching request; failed validation
keeps it available for retry. Request the intended set explicitly instead of
relying on unrequested certificates.

An `initialRequest` is unsigned, and the v0.1 `initialResponse` signature binds
the nonce pair and identity but not its `requestedCertificates` or
`certificates` members. Built-in wallet proving encrypts revealed field keys to
the requested identity, but a certificate-request callback can observe only a
claimed identity during the initial exchange. Do not disclose plaintext or
authorize side effects from that callback. Because the requested set is
mutable, make every decision from the certificates and fields actually
disclosed and validated, never from the request alone. Prefer wallet-backed
proof creation, and use a signed post-authentication certificate request or an
application-layer integrity check when request integrity itself matters.

`listenForCertificatesReceived` is an observer. The SDK commits certificate
validation and releases its waiters before invoking listeners. A throwing or
rejecting listener stops later listeners and rejects message handling, but does
not roll back validation. The callback's third argument is the local session
nonce and its optional fourth argument is the peer nonce, allowing adapters to
bind application approval to the exact validated exchange; existing two-argument
callbacks remain compatible. Apply the requested certificate policy and
explicit application authorization before performing protected work.

Custom `AsyncSessionManager` implementations must retain the complete
`PeerSession`, including the optional local `certificatePolicy` and
`pendingCertificateRequests` fields. They are never serialized into AuthMessage.
Peer serializes its own certificate read-modify-write operations; shared stores
must also coordinate writers across instances. Older stored sessions without
these fields use the configured handshake policy.

The in-process session store evicts only unauthenticated sessions at capacity.
If every slot is authenticated, new handshakes fail until a session expires or
is removed. Only a successful locally initiated handshake can select the
implicit destination for a later `Peer` call; inbound messages cannot retarget
it.

### Wallet discovery deadlines since 2.8.2

Automatic React Native and XDM probes retain their short discovery deadlines
and remove listeners when unavailable. A successful probe creates a separate
operational connection so authentication, permission approval and valid slow
responses do not inherit the one-second/200-millisecond discovery deadline.
Explicitly configured substrate `responseTimeout` values remain enforced, and
response validation and origin checks are unchanged. No API or wire migration
is needed. Applications affected by the timeout defect can update their bundled
SDK; a wallet release alone cannot replace code served by a web application.
