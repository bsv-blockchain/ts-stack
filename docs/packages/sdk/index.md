---
id: sdk-domain
title: SDK
kind: meta
domain: sdk
version: "n/a"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
status: stable
tags: ["domain", "sdk"]
---

# SDK

The foundation of ts-stack. Core cryptographic primitives and transaction building.

## Packages in this Domain

- [@bsv/sdk](./bsv-sdk.md) — Keys, signatures, transactions, BEEF, SPV

## What You Can Do

- Generate and manage private keys
- Sign and verify cryptographic signatures
- Build and serialize transactions
- Create and validate Simplified Payment Verification (SPV) proofs
- Encode and decode BEEF (Binary Encoded Extended Format)
- Work with Bitcoin Script

## When to Use

Every project using ts-stack starts with the SDK. It's the foundational layer for:

- Transaction building and broadcasting
- Key management (if you're not using a wallet)
- Signature verification (for authentication)
- SPV proof validation

## Key Concepts

- **Private Key** — Secret key that controls UTXOs and signs data
- **Public Key** — Derived from private key, shared with others
- **Transaction** — Collection of inputs (money in) and outputs (money out)
- **UTXO** — Unspent transaction output you can spend
- **BEEF** — Format that bundles a transaction with merkle proofs
- **SPV** — Verify a transaction is in the chain without the full chain
- **Script** — Bitcoin Script that controls who can spend an output

## Quick Example

\`\`\`typescript
import { PrivateKey, Transaction } from '@bsv/sdk';

// Create a key
const key = PrivateKey.fromRandom();

// Build a transaction
const tx = new Transaction().addInput(...).addOutput(...);

// Sign it
const signature = key.sign(tx);

// Encode as BEEF for transmission
const beef = Beef.fromTransaction(tx, proofs);
\`\`\`

## Next Steps

- **[@bsv/sdk](./bsv-sdk.md)** — Full API reference
- **[Guides](../../guides/index.md)** — Hands-on examples
