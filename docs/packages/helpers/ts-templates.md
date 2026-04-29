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

Locking and unlocking script templates for common BSV patterns — P2PKH, P2PK, multisig, PushDrop, and OP_RETURN scripts.

## Install

```bash
npm install @bsv/templates
```

## Quick start

```typescript
import { P2PKH, P2PK, OpReturn } from '@bsv/templates';

// Create a P2PKH locking script
const pubkeyhash = Buffer.from('...', 'hex');
const lockingScript = P2PKH.lock(pubkeyhash);

// Create a P2PK locking script
const publicKey = Buffer.from('...', 'hex');
const p2pkScript = P2PK.lock(publicKey);

// Create an OP_RETURN script with data
const dataScript = OpReturn.lock([
  Buffer.from('Some data'),
  Buffer.from('More data')
]);

// Unlock a P2PKH output
const signature = /* signature from private key */;
const unlockingScript = P2PKH.unlock(signature, publicKey);
```

## What it provides

- **P2PKH** — Pay to Public Key Hash (standard Bitcoin addresses)
- **P2PK** — Pay to Public Key (simpler than P2PKH)
- **Multisig** — M-of-N multisignature scripts
- **PushDrop** — Data carrying pattern with push operations
- **OP_RETURN** — Unspendable outputs for data storage
- **Custom templates** — Framework for defining custom patterns
- **Script validation** — Verify script correctness
- **Serialization** — Encode/decode scripts from bytes

## When to use

- Creating standard locking scripts for transactions
- Building applications that need P2PKH or P2PK payment flows
- Storing data on-chain with OP_RETURN
- Implementing multisig wallets
- Learning Bitcoin Script patterns

## When not to use

- For complex custom scripts — use @bsv/sdk Script directly
- If you only need pre-signed transactions — skip templates
- For non-standard script types — implement custom scripts
- For testing scripts — use @bsv/sdk Script execution

## API reference

Full TypeScript API documentation: [TypeDoc](https://bsv-blockchain.github.io/ts-stack/api/templates/)

## Related packages

- @bsv/sdk — Script execution and transaction building
- @bsv/wallet-toolbox — Uses templates for transaction creation
- @bsv/wallet-helper — Higher-level builders using templates
