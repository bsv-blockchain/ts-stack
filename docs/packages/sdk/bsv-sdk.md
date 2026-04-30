---
id: bsv-sdk
title: "@bsv/sdk"
kind: package
domain: sdk
version: "2.0.14"
npm: "@bsv/sdk"
last_updated: "2026-04-30"
last_verified: "2026-04-30"
review_cadence_days: 30
status: stable
tags: ["sdk", "crypto", "transactions"]
github_repo: "https://github.com/bsv-blockchain/ts-stack"
---

# @bsv/sdk

The foundational cryptographic and transaction library for the BSV blockchain. Zero external dependencies — all cryptographic primitives have been validated by a third-party auditor. Every other library in the ts-stack builds on top of `@bsv/sdk`. <!-- audio: ts-stack.m4a @ 27:00 -->

Provides low-level primitives (keys, signatures, hashing), script construction and execution, transaction creation and signing, and integration interfaces for wallets and overlay networks.

## Install

```bash
npm install @bsv/sdk
```

## Quick start

```typescript
import { PrivateKey, P2PKH, Transaction } from '@bsv/sdk'

const privKey = PrivateKey.fromWif('L5EY1SbTvvPNSdCYQe1EJHfXCBBT4PmnF6CDbzCm9iifZptUvDGB')
const sourceTransaction = Transaction.fromHex('0200000001...')  // Previous tx hex

const tx = new Transaction(1, [
  {
    sourceTransaction,
    sourceOutputIndex: 0,
    unlockingScriptTemplate: new P2PKH().unlock(privKey)
  }
], [
  {
    lockingScript: new P2PKH().lock(privKey.toAddress()),
    satoshis: 5000,
    change: true
  }
])

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
- **Network integration** — `ARC`, `WhatsOnChainBroadcaster`, `Teranode` broadcasters; `DefaultChainTracker`, `WhatsOnChainChainTracker`
- **SPV verification** — `MerklePath` for merkle inclusion proofs
- **BEEF envelopes** — `Beef` (BRC-62) for atomic transaction batches with proofs
- **Message signing** — BRC-18 signed messages
- **Wallet interface** — `WalletInterface` (BRC-100), `WalletClient()` factory, `ProtoWallet` for testing
- **Auth & identity** — `Certificate`, `IdentityKey`, `AuthModule` for peer authentication
- **Storage & KV** — `Storage` interface with `LocalStorageAdapter`, `InMemoryStorage`; `KVStore` for distributed data
- **Overlay integration** — `TopicBroadcaster`, `TopicListener`, `RemittanceProtocol`, `IdentityResolver`, `Registry`
- **2FA** — `generateTOTP()`, `verifyTOTP()` for time-based one-time passwords

## Common patterns

### Build a P2PKH transaction

```typescript
import { PrivateKey, P2PKH, Transaction } from '@bsv/sdk'

const privKey = PrivateKey.fromWif('L5EY1SbTvvPNSdCYQe1EJHfXCBBT4PmnF6CDbzCm9iifZptUvDGB')
const sourceTransaction = Transaction.fromHex('0200000001...')

const tx = new Transaction(1, [
  {
    sourceTransaction,
    sourceOutputIndex: 0,
    unlockingScriptTemplate: new P2PKH().unlock(privKey)
  }
], [
  {
    lockingScript: new P2PKH().lock(privKey.toAddress()),
    satoshis: 5000,
    change: true
  }
])

await tx.sign()
```

### Connect to a BRC-100 wallet

```typescript
import { P2PKH, WalletClient } from '@bsv/sdk'

const wallet = new WalletClient('auto', 'example.com')
const recipientAddress = '1EvmsbpAY7nESLkN4ajLTMbvsaQ1HpJPGX'
const lockingScript = new P2PKH()
  .lock(recipientAddress)
  .toHex()

const { publicKey } = await wallet.getPublicKey({
  identityKey: true
})

const action = await wallet.createAction({
  description: 'Create payment',
  outputs: [{
    lockingScript,
    satoshis: 1000,
    outputDescription: 'Payment output'
  }]
})

console.log(publicKey, action.txid)
```

`WalletClient` implements the BRC-100 method surface. It discovers a wallet substrate such as BSV Desktop over localhost or BSV Browser over a postMessage bridge.

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
import { PushDrop, Script } from '@bsv/sdk'

const tokenFields = ['myAssetId', '100', JSON.stringify({ name: 'MyToken' })]
const tokenScript = PushDrop.createFromFields(tokenFields)
const output = { lockingScript: tokenScript, satoshis: 1 }
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
