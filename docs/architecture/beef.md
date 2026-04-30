---
id: architecture-beef
title: BEEF — Background Evaluation Extended Format (BRC-62)
kind: meta
version: "n/a"
last_updated: "2026-04-29"
last_verified: "2026-04-29"
review_cadence_days: 30
status: stable
tags: ["architecture", "BEEF", "BRC-62", "SPV"]
---

# BEEF — Background Evaluation Extended Format (BRC-62)

BEEF is the standardized binary format for peer-to-peer transaction exchange on BSV. It bundles a transaction with the Merkle proofs needed to verify its inclusion in the chain, enabling Simplified Payment Verification (SPV) without a full node.

## Why BEEF?

Traditional transaction relay requires a recipient to either:
- Trust the sender ("this transaction is valid"), or
- Query a full node to verify inputs

BEEF eliminates both requirements. The sender includes all proof material inline; the recipient validates against block headers it already has (from a Chaintracks server or equivalent).

## Wire Format

A BEEF package always begins with the 4-byte version header `0100BEEF` (little-endian `0xBEEF0001`).

The payload is ordered specifically to support streaming validation:

```
[0100BEEF version header]
[BUMP structures — BSV Unified Merkle Paths (BRC-74)]
[Ancestor transactions — the minimal set of parents reaching a mined anchor]
[The final transaction being evaluated]
```

This ordering is deliberate: a recipient can begin verifying Merkle roots against its block header service as soon as the BUMPs arrive, before the full payload has been received.

## BUMPs — BSV Unified Merkle Paths (BRC-74)

A BUMP is an optimized Merkle proof format. Key properties:

- Uses **block height** as a lookup target rather than block hash, minimizing byte size.
- Supports **compounding** — multiple transaction proofs can be merged into a single BUMP structure when they appear in the same block, sharing common Merkle tree nodes.

The `MerklePath` class in `@bsv/sdk` implements BRC-74 encoding, decoding, and compound path operations.

## Ancestor Transactions

BEEF includes the minimal set of parent transactions required to reach a mined anchor on the longest chain. Each included ancestor either:
- Has a BUMP (is confirmed), or
- Has its own ancestors included in the package

This creates a proof chain: the final transaction → unconfirmed parents → confirmed ancestors with BUMPs.

## BEEF V2 (BRC-95)

BRC-95 is a revised BEEF format that extends BRC-62. Both versions are supported by `@bsv/sdk`. Check `Beef.version` to distinguish them at runtime.

## Streaming Validation

The ordering of BEEF enables a pipeline:

1. Receiver begins parsing BUMPs immediately.
2. BUMPs are verified against block headers (Chaintracks). This can happen before the transactions arrive.
3. Ancestor transactions are validated in order, each checking its inputs against the already-validated chain.
4. Final transaction is evaluated with all inputs proven.

Any failure in the chain aborts early without processing the remaining bytes.

## Usage in @bsv/sdk

```typescript
import { Beef, MerklePath, Transaction, WhatsOnChain } from '@bsv/sdk'

declare const tx: Transaction
declare const bump: MerklePath

// Build a BEEF from a transaction and proof
const beef = new Beef()
beef.mergeTransaction(tx)
beef.mergeBump(bump)
const bytes = beef.toBinary()

// Parse and validate
const parsed = Beef.fromBinary(bytes)
const isValid = await parsed.verify(new WhatsOnChain())
```

## Where BEEF Appears

BEEF is used throughout the stack wherever transactions cross system boundaries:

- **BRC-100 `createAction` / `internalizeAction`** — Actions return BEEF; the recipient wallet calls `internalizeAction` with the BEEF to credit funds.
- **Overlay submission** — All transactions submitted to an overlay via `engine.submit()` must be in BEEF format.
- **BRC-121 (HTTP 402)** — Micropayment sent in HTTP headers is BEEF-encoded.
- **BRC-29 (Peer payment)** — Payment transaction transmitted as BEEF.
- **GASP sync** — Overlay nodes exchange BEEF during graph synchronization.

## Related

- [BRC-100 Wallet Interface](./brc-100.md) — `internalizeAction` and `createAction` use BEEF
- [Conformance vectors](../conformance/index.md) — `conformance/vectors/sdk/transactions/`
- [MerklePath TypeDoc](../packages/sdk/bsv-sdk.md) — `@bsv/sdk` MerklePath and Beef classes
