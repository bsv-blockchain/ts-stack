---
id: bsv-sdk
title: "@bsv/sdk"
kind: package
domain: sdk
version: "1.0.0"
npm: "@bsv/sdk"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
status: stable
tags: ["sdk", "crypto", "transactions"]
---

# @bsv/sdk

Core cryptographic and transaction primitives for BSV blockchain applications.

## Features

- **Private Key Management** — Generate, import, and manage private keys
- **Signatures** — Sign and verify using ECDSA
- **Transaction Building** — Create transactions with inputs and outputs
- **BEEF Support** — Encode and decode Binary Encoded Extended Format
- **SPV Proofs** — Validate transactions with merkle proofs
- **Bitcoin Script** — Write and execute Bitcoin Script

## Installation

```bash
npm install @bsv/sdk
```

## Quick Start

```typescript
import { PrivateKey } from '@bsv/sdk';

// Create a random private key
const key = PrivateKey.fromRandom();
console.log('Public Key:', key.publicKey.toString());

// Sign a message
const message = 'hello bsv';
const signature = key.sign(message);

// Verify the signature
const isValid = key.publicKey.verify(message, signature);
console.log('Valid:', isValid);
```

## Key Classes

- **PrivateKey** — Manage a private key and derive public key
- **PublicKey** — Verify signatures and encrypt data
- **Transaction** — Build and sign transactions
- **Beef** — Encode/decode BEEF format with proofs
- **MerkleProof** — Validate transactions in the chain
- **Script** — Write and execute Bitcoin Script

## Common Tasks

### Generate a New Key

```typescript
const key = PrivateKey.fromRandom();
```

### Load an Existing Key

```typescript
const key = PrivateKey.fromString(wif);
```

### Build a Transaction

```typescript
const tx = new Transaction()
  .addInput(prevTx, outputIndex)
  .addOutput(satoshis, script);

const signature = key.sign(tx);
```

### Verify a BEEF

```typescript
const beef = Beef.fromBytes(beefBytes);
const isValid = beef.verify();
```

## Documentation

- [GitHub Repository](https://github.com/bsv-blockchain/ts-stack)
- [NPM Package](https://www.npmjs.com/package/@bsv/sdk)

## Guides

- [Get Started](../../get-started/index.md)
- [Key Concepts](../../get-started/concepts.md)

## Next Steps

- Use [Wallet Toolbox](../wallet/wallet-toolbox.md) for full wallet functionality
- Use [Network](../network/index.md) packages to broadcast transactions
- Explore [Guides](../../guides/index.md) for practical examples
