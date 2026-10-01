---
id: pkg-simple
title: '@bsv/simple'
kind: package
domain: helpers
version: '0.7.0'
source_repo: 'bsv-blockchain/ts-stack'
last_updated: '2026-09-30'
last_verified: '2026-09-30'
review_cadence_days: 30
npm: 'https://www.npmjs.com/package/@bsv/simple'
repo: 'https://github.com/bsv-blockchain/ts-stack/tree/main/packages/helpers/simple'
status: stable
tags: [helpers, simple, payments]
---

# @bsv/simple

> High-level wallet APIs for browser and server, with deterministic identity-key DIDs and signature-preserving encrypted certificate envelopes.

Version 0.7.0 is an unpublished source candidate implementing the proposed BRC-202/203 profiles. It removes the mutable DID adapter and old VC/VP proof wrappers. See the [identity/DID/VC migration guide](../../guides/identity-did-vc-migration.md) before upgrading. Proposed extensions are unregistered; generic W3C conformance and deployed interoperability are not claimed.

## Install

```bash
npm install @bsv/simple @bsv/sdk
```

## Quick start

```typescript
import { createWallet } from '@bsv/simple/browser'

const wallet = await createWallet()
const recipientIdentityKey = '025706528f0f6894b2ba505007267ccff1133e004452a1f6b72ac716f246216366'

// Send a payment via MessageBox P2P
const result = await wallet.pay({
  to: recipientIdentityKey,
  satoshis: 1000
})

console.log('Paid:', result.txid)
```

## What it provides

- **Browser wallet** — Create and use wallets in-browser
- **Server wallet** — Server-side wallet with private key management
- **Balance queries** — Get wallet balance and per-basket balances
- **Payments** — Send satoshis via MessageBox P2P or direct on-chain
- **Tokens** — Create, list, send, redeem encrypted PushDrop tokens
- **Inscriptions** — Create OP_RETURN inscriptions (text, JSON, file hashes)
- **Identity-key DIDs** — Encode compressed secp256k1 identity keys as BRC-202 `did:key` identifiers and resolve offline
- **Encrypted credentials** — Issue/acquire BRC-52 certificates and export/verify BRC-203 envelopes with original signatures and ciphertext
- **MessageBox integration** — Handle identity tags, registries, and P2P payments

## Common patterns

### Check wallet balance

```typescript
const balance = await wallet.getBalance()
console.log(`Balance: ${balance.totalSatoshis} satoshis`)

// Per-basket balance
const tokenBalance = await wallet.getBalance('tokens')
console.log(`Spendable: ${tokenBalance.spendableSatoshis}`)
```

### Register for MessageBox and send payment

```typescript
// Register identity handle
await wallet.certifyForMessageBox('@alice', '/api/identity-registry')

// Find recipient and send payment
const results = await wallet.lookupIdentityByTag('bob', '/api/identity-registry')
await wallet.sendMessageBoxPayment(results[0].identityKey, 1000)
```

### Create and transfer tokens

```typescript
const recipientIdentityKey = '025706528f0f6894b2ba505007267ccff1133e004452a1f6b72ac716f246216366'

// Create token
const token = await wallet.createToken({
  data: { type: 'loyalty', points: 100 },
  basket: 'my-tokens'
})

// List tokens
const tokens = await wallet.listTokenDetails('my-tokens')

// Send token to another key
await wallet.sendToken({
  basket: 'my-tokens',
  outpoint: tokens[0].outpoint,
  to: recipientIdentityKey
})
```

### Direct payments (BRC-29 derivation)

```typescript
// Server generates payment request
const request = serverWallet.createPaymentRequest({ satoshis: 2000 })

// Browser creates BRC-29 derived transaction
const payment = await browserWallet.sendDirectPayment(request)

// Server receives and internalizes
await serverWallet.receiveDirectPayment({
  tx: payment.tx,
  senderIdentityKey: payment.senderIdentityKey,
  derivationPrefix: payment.derivationPrefix,
  derivationSuffix: payment.derivationSuffix,
  outputIndex: payment.outputIndex
})
```

## Key concepts

- **Basket** — Logical grouping of outputs for wallet organization
- **Identity key** — Compressed public key hex (66 chars) for P2P messaging
- **BRC-29 derivation** — Automatic hierarchical key derivation without exposing private keys
- **MessageBox** — P2P payment and message transport via a Message Box server
- **Overlay** — SHIP/SLAP broadcast and lookup with explicit `teratestnet`
  routing alongside mainnet, testnet, and local presets
- **Identity-key DID** — An immutable key representation; resolution proves encoding, not live control, legal identity, issuer trust, or authorization.
- **BRC-203 envelope** — The original signed certificate binary and its closed encrypted graph. Disclosure results, verifier keyrings, trust, and status remain separate evidence.
- **Certificate status** — A local revocation secret proves neither current nor spent chain status. Use explicit status-source and freshness policy; missing local records remain unknown.

## Identity and credential APIs

```typescript
import { DID } from '@bsv/simple'

// Public specification test value, never a production identity.
const identityKey = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const identityDid = DID.fromIdentityKey(identityKey)
const resolution = DID.resolve(identityDid)
console.log(resolution.didDocument?.id)
```

`wallet.getDID()` returns the selected identity key's Multikey document. `wallet.resolveDID(did)` returns a synchronous offline resolution result. A different key creates a different DID; there is no transaction-based creation, update, rotation, recovery, deactivation, registration, or remote resolver fallback. Certificate revocation does not stop the subject DID resolving.

`wallet.acquireCredential(config)` and `wallet.listCredentials({ certifiers, types })` return authenticated `BRC52Envelope` values. The acquisition flow verifies export compatibility before modifying wallet certificates. The envelope preserves the original signed binary/ciphertext and exports no stored subject/master keyring.

`CredentialIssuer.issueCertificate(subjectKey, schemaId, fields)` retains BRC-52 delivery data for the authorized certify endpoint. `issuer.issue(...)` returns `{ credential, keyringForSubject }`; subject-keyring delivery stays outside the authenticated graph. `issuer.verify(envelopeJson)` accepts a string or UTF-8 bytes and returns `BRC52VerificationResult`: `verified`, `verifiedDocument`, `mediaType`, and `errors`. Display only the verified document, and assess issuer trust, disclosure authorization, holder control, and chain status independently.

`issuer.getRevocationRecordStatus(serial)` reports local `retained` or `unknown`. The generated status handler returns chain `status: 'unknown'`; use `@bsv/did`'s explicit status API for disabled/current/spent evidence. Existing issuance and hash-lock revocation can perform wallet operations and require application authorization. The retired wrappers and unsigned presentation helpers have no implicit holder-proof replacement.

See the [package migration notes](https://github.com/bsv-blockchain/ts-stack/blob/main/packages/helpers/simple/docs/guides/identity-credential-migration.md) for the full old-to-new API map. Historical chain records and wallet storage are retained; transaction DIDs and certificate serials must not be guessed into subject identities.

## When to use this

- Building BSV web applications with wallets
- Implementing P2P payment systems
- Managing BRC-52 credentials and expressing their issuer/subject identity keys
- Creating token-based loyalty or reward systems
- Building identity/authentication systems

## When NOT to use this

- For low-level transaction control — use @bsv/sdk
- For lightweight script templates — use @bsv/templates
- When you need the fluent builder pattern — use @bsv/wallet-helper

## Spec conformance

- **BRC-29** — Hierarchical key derivation
- **BRC-42** — Public key derivation
- **BRC-95** — PushDrop tokens
- **BRC-100** — Wallet interface
- **Proposed BRC-202** — Deterministic secp256k1 identity-key subset of the community `did:key` method
- **Proposed BRC-203** — Original BRC-52 signature-preserving custom credential mechanism, not a registered W3C signature suite

## Common pitfalls

- **`basket insertion` vs `wallet payment` are mutually exclusive** — You cannot use both on the same output in a single transaction
- **PeerPayClient swallows errors** — Always check `if (typeof result === 'string') throw new Error(result)`
- **`result.tx` may be undefined** — Check before using for overlay broadcasting
- **FileRevocationStore is server-only** — Import from `@bsv/simple/server`, not browser
- **Overlay topics must start with `tm_`; lookup services with `ls_`** — The Overlay class enforces these prefixes

## Related packages

- [@bsv/wallet-helper](wallet-helper.md) — Fluent transaction builder
- [@bsv/templates](templates.md) — Low-level script templates
- [@bsv/sdk](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/sdk) — Core transaction building

## Reference

- [API reference (TypeDoc)](https://bsv-blockchain.github.io/ts-stack/api/simple/)
- [Source on GitHub](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/helpers/simple)
- [npm](https://www.npmjs.com/package/@bsv/simple)
