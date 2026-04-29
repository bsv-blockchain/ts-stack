---
id: pkg-templates
title: "@bsv/templates"
kind: package
domain: helpers
version: "1.4.0"
source_repo: "bsv-blockchain/templates"
source_commit: "unknown"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
npm: "https://www.npmjs.com/package/@bsv/templates"
repo: "https://github.com/bsv-blockchain/templates"
status: stable
tags: [templates, scripts, locking, unlocking]
---

# @bsv/templates

> Low-level BSV script templates library — provides reusable locking/unlocking script implementations (OpReturn, MultiPushDrop, P2MSKH) for common and advanced Bitcoin SV patterns without abstracting away control.

## Install

```bash
npm install @bsv/templates
```

## Quick start

```typescript
import { Transaction, PrivateKey } from '@bsv/sdk'
import { OpReturn, MultiPushDrop, P2MSKH } from '@bsv/templates'

// Create OP_RETURN transaction
const tx = new Transaction()
const opReturn = new OpReturn()
tx.addOutput({
  lockingScript: opReturn.lock(['APP', JSON.stringify({ action: 'vote' })]),
  satoshis: 0
})
await tx.sign()
console.log(tx.id())

// Decode OP_RETURN data
const decodedData = OpReturn.decode(tx.outputs[0].lockingScript)
console.log(decodedData)  // ['APP', '{"action":"vote"}']
```

## What it provides

- **OpReturn** — Non-spendable data storage; create and decode OP_RETURN scripts
- **MultiPushDrop** — Encrypted data tokens with multiple trusted owners; BRC-95 format
- **P2MSKH** — Pay-to-Multisig-Key-Hash; M-of-N threshold signing with wallet support
- **Script utilities** — Type detection, parsing, serialization helpers
- **Wallet integration** — Templates accept WalletInterface for BRC-29/BRC-42 derivation

## Common patterns

### Create and unlock P2PKH lock and unlock
```typescript
import { Transaction, PrivateKey } from '@bsv/sdk'

const privKey = new PrivateKey()
const pubkey = privKey.toPublicKey()
const lockingScript = new OpReturn().lock([pubkey.toHex()])

const tx = new Transaction()
tx.addOutput({ lockingScript, satoshis: 1000 })
// Sign with privKey to unlock...
```

### Create MultiPushDrop token with 2 trusted owners
```typescript
const pushDrop = new MultiPushDrop()
const lockingScript = await pushDrop.lock(
  [[1, 2, 3], [4, 5, 6]],  // Two fields
  [2, 'token'],            // protocol
  'key-1',
  ['owner1-pubkey', 'owner2-pubkey'],  // Both can unlock
  true                     // reasonableness limit
)

const tx = new Transaction()
tx.addOutput({ lockingScript, satoshis: 1 })

// Spend MultiPushDrop
const unlocker = pushDrop.unlock(
  [2, 'token'],
  'key-1',
  ['owner1-pubkey', 'owner2-pubkey']
)
const unlockingScript = await unlocker.sign(tx, 0)
```

### Create 2-of-3 multisig
```typescript
const p2mskh = new P2MSKH(2, 3)
const multiSigLock = await p2mskh.lock({
  publicKeys: [pubkey1, pubkey2, pubkey3]
})

const tx = new Transaction()
tx.addOutput({ lockingScript: multiSigLock, satoshis: 10000 })

// Spend 2-of-3 (need 2 of 3 signatures)
const multiSigUnlocker = p2mskh.unlock({
  publicKeys: [pubkey1, pubkey2, pubkey3],
  signingKeys: [privkey1, privkey2]  // Supply 2 of 3 private keys
})
const unlockingScript = await multiSigUnlocker.sign(tx, 0)
```

## Key concepts

- **ScriptTemplate Interface** — Implements `lock()` to create locking script and `unlock()` to sign/spend
- **OP_RETURN** — Immutable, non-spendable data storage; standard for metadata
- **PushDrop** — Encrypted data format with multi-trusted-owner support; fields are encrypted
- **Multisig** — M-of-N threshold signing; requires m private keys to unlock
- **Wallet Integration** — Templates accept WalletInterface for wallet-compatible key derivation (BRC-29, BRC-42)
- **Direct Key Mode** — Can also use raw public/private keys without wallet
- **Protocol ID** — Identifier for script family; used in wallet derivation contexts
- **Reasonableness Limit** — Anti-DoS measure for PushDrop templates

## When to use this

- Creating standard locking scripts for transactions
- Building applications that need P2PKH or multisig payment flows
- Storing data on-chain with OP_RETURN
- Implementing multi-owner token systems with PushDrop
- Learning Bitcoin Script patterns

## When NOT to use this

- For ultra-high-level operations — use @bsv/simple
- For fluent transaction building — use @bsv/wallet-helper
- When you only need pre-signed transactions — skip templates
- For testing scripts — use @bsv/sdk Script execution directly

## Spec conformance

- **OP_RETURN** — Standard Bitcoin data format
- **BRC-95** — PushDrop token format
- **BRC-29** — Hierarchical key derivation (in wallet context)
- **BRC-42** — Public key derivation (in wallet context)
- **Bitcoin Script** — All scripts are valid Bitcoin SV scripts

## Common pitfalls

- **OP_RETURN is read-only** — Cannot spend OP_RETURN outputs; used for data only
- **Lock/Unlock consistency** — Lock and unlock must use same protocol ID, key ID, and counterparty parameters
- **Wallet context required** — Some templates require WalletInterface if using wallet derivation; pass explicitly
- **Signature generation async** — All `unlock().sign()` calls are async; use await
- **OP_RETURN encoding** — Data is UTF-8 by default; encode as hex first and specify `enc: 'hex'` for binary

## Related packages

- [@bsv/wallet-helper](wallet-helper.md) — Higher-level abstraction over these templates
- [@bsv/simple](simple.md) — Wallet-level operations
- [@bsv/sdk](https://github.com/bsv-blockchain/sdk-ts) — Core transaction building and script execution

## Reference

- [API reference (TypeDoc)](https://bsv-blockchain.github.io/ts-stack/api/templates/)
- [Source on GitHub](https://github.com/bsv-blockchain/templates)
- [npm](https://www.npmjs.com/package/@bsv/templates)
