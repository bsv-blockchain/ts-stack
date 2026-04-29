---
id: guide-wallet-aware
title: "Build a Wallet-Aware App"
kind: guide
version: "1.0.0"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
status: stable
tags: [guide, wallet, brc-100, typescript]
---

# Build a Wallet-Aware App

Create a TypeScript application that interacts with user wallets using the BRC-100 WalletInterface.

## What You'll Learn

- How to use the BRC-100 wallet interface
- Creating transactions with wallet-toolbox
- Signing transactions with user keys
- Handling encrypted data
- Building a complete wallet-aware flow

## What You'll Build

A simple payment application that:
1. Connects to a user's wallet
2. Retrieves available keys
3. Creates a transaction sending funds
4. Signs and broadcasts it to the network

## Prerequisites

- Node.js 18+
- Basic TypeScript knowledge
- Understanding of Bitcoin transactions

## Stack

- @bsv/sdk — Bitcoin protocol primitives
- @bsv/wallet-toolbox — Wallet implementation
- @bsv/authsocket-client — Wallet connection

## Getting Started

See full guide at `/docs/guides/wallet-aware-app-full/`.

## Key Concepts

### BRC-100 Interface

The BRC-100 standard defines a unified wallet interface:

```typescript
interface WalletInterface {
  getPublicKey(derivationKey?: string): Promise<string>;
  createAction(description: string, outputs: Output[]): Promise<Action>;
  signAction(actionId: string, derivationKey?: string): Promise<void>;
  createSignature(message: string): Promise<string>;
}
```

### Creating Actions

An action is a transaction before signing:

```typescript
const action = await wallet.createAction('Payment', [
  {
    satoshis: 5000,
    script: '76a914...'
  }
]);
```

### Signing

Sign the action with a private key:

```typescript
await wallet.signAction(action.id);
```

## Next Steps

- [BRC-100 Specification](/docs/specs/brc-100-wallet/) — Protocol details
- [Wallet-Toolbox Package](/docs/packages/wallet-toolbox/) — Implementation
- [Conformance Vectors](/docs/conformance/vectors/) — Expected behavior
