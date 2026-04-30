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
import { OpReturn } from '@bsv/templates'

const opReturn = new OpReturn()
const lockingScript = opReturn.lock(['APP', JSON.stringify({ action: 'vote' })])

console.log(lockingScript.toHex())

const decodedData = OpReturn.decode(lockingScript)
console.log(decodedData)  // ['APP', '{"action":"vote"}']
```

## What it provides

- **OpReturn** — Non-spendable data storage; create and decode OP_RETURN scripts
- **MultiPushDrop** — Encrypted data tokens with multiple trusted owners; BRC-95 format
- **P2MSKH** — Pay-to-Multisig-Key-Hash; M-of-N threshold signing with wallet support
- **Script utilities** — Type detection, parsing, serialization helpers
- **Wallet integration** — Templates accept WalletInterface for BRC-29/BRC-42 derivation

## Common patterns

### Create and decode an OP_RETURN script
```typescript
import { OpReturn } from '@bsv/templates'

const script = new OpReturn().lock(['my-app', 'invoice-paid'])
const fields = OpReturn.decode(script)

console.log(fields) // ['my-app', 'invoice-paid']
```

### Create MultiPushDrop token with 2 trusted owners
```typescript
import { SecurityLevel, Utils, type WalletInterface } from '@bsv/sdk'
import { MultiPushDrop } from '@bsv/templates'

declare const creatorWallet: WalletInterface
declare const ownerWallet: WalletInterface

const counterparties = [
  '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5',
  '03f028892bad7ed57d2fb57bf33081d5cfcf6f9ed3d3d7f159c2e2fff579dc341a'
]
const protocolID: [SecurityLevel, string] = [0, 'example token']
const keyID = 'ticket-1'

const pushDrop = new MultiPushDrop(creatorWallet)
const lockingScript = await pushDrop.lock(
  [Utils.toArray('ticket', 'utf8'), [1, 2, 3]],
  protocolID,
  keyID,
  counterparties
)

const decoded = MultiPushDrop.decode(lockingScript)
console.log(decoded.lockingPublicKeys.length) // 2

// The first owner can build the unlock template for a spending transaction.
const { publicKey: creatorIdentityKey } = await creatorWallet.getPublicKey({ identityKey: true })
const unlocker = new MultiPushDrop(ownerWallet).unlock(
  protocolID,
  keyID,
  creatorIdentityKey
)
```

### Create 2-of-3 multisig
```typescript
import { PublicKey, type WalletInterface } from '@bsv/sdk'
import { P2MSKH } from '@bsv/templates'

declare const wallet: WalletInterface

const pubkey1 = '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'
const pubkey2 = '03f028892bad7ed57d2fb57bf33081d5cfcf6f9ed3d3d7f159c2e2fff579dc341a'
const pubkey3 = '02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9'
const pubkeys = [
  PublicKey.fromString(pubkey1),
  PublicKey.fromString(pubkey2),
  PublicKey.fromString(pubkey3)
]

const address = P2MSKH.address(pubkeys, 2)
const lockingScript = new P2MSKH().lock(address)

// Spending uses wallet-derived signatures. Each signer applies the same
// customInstructions and passes the prior partial unlocking script onward.
const customInstructions = {
  keyID: 'escrow-1',
  counterparty: 'self',
  pubkeys: pubkeys.map(pubkey => pubkey.toString())
}
const unlocker = new P2MSKH().unlock(wallet, customInstructions)
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
