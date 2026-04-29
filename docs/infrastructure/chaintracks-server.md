---
id: infra-chaintracks-server
title: "Chaintracks Server"
kind: infra
version: "n/a"
last_updated: "2026-04-29"
last_verified: "2026-04-29"
review_cadence_days: 30
status: stable
tags: [chaintracks, block-headers, spv, merkle, infrastructure]
---

# Chaintracks Server

Chaintracks Server is the reference implementation for BSV block header management. It maintains a complete chain of block headers and exposes an API for Merkle root validation — the header-side half of Simplified Payment Verification (SPV). <!-- audio: Chaintracks server.m4a @ 00:00 -->

The Chaintracks primitives and client interface are defined in `@bsv/wallet-toolbox`. This server is the reference deployment of those primitives.

## What it does

- Listens to Teranode peer-to-peer messages for live block header announcements
- Maintains a chain of headers from genesis to the current tip
- Exposes an API for validating individual Merkle root / block height assertions
- Provides bulk header lookup for downstream services

## Startup and Bootstrap

On first start, Chaintracks must acquire ~900,000 existing BSV block headers before it can validate recent transactions. The bootstrap sequence:

1. **Bundled files** — The repository ships with bulk header files. If no CDN URL is configured, these files are used for the initial bulk ingest.
2. **CDN bulk ingest** — If a CDN URL is configured (typically another running Chaintracks server), headers are fetched 100,000 at a time. This is the fastest path.
3. **WhatsOnChain bulk ingester** — Fallback if bundled files and CDN are unavailable.
4. **Live tip sync** — Once bulk headers are loaded, the server switches to live mode: ingesting new block headers from Teranode P2P connections or the WhatsOnChain live ingester. <!-- audio: Chaintracks server.m4a @ 00:40 -->

## API

The primary purpose of the API is individual Merkle root / block height validation:

```
GET /blockHeaderForHeight?height=100
→ { hash, merkleRoot, ... }

POST /verifyMerkleRoot
body: { blockHeight: 100, merkleRoot: "abc123..." }
→ { valid: true }
```

Applications (primarily `@bsv/wallet-toolbox`) ask: "Does block height 100 have Merkle root `X`?" The server responds valid or not. This is what `Beef.verify()` calls internally to confirm Merkle proofs. <!-- audio: Chaintracks server.m4a @ 03:40 -->

## Configuration

```bash
# Bootstrap from another Chaintracks server
CHAINTRACKS_CDN_URL=https://chaintracks.example.com

# Use WhatsOnChain live ingester instead of Teranode
WHATS_ON_CHAIN_LIVE=true
```

Teranode P2P connection requires bootstrap peer configuration to enter the node network.

## When to deploy this

- Running `@bsv/wallet-toolbox`-based wallets in production (the toolbox calls Chaintracks for SPV)
- Need in-house Merkle root validation instead of relying on a third-party instance
- Building services that need to validate BEEF packages server-side

## When NOT to deploy this

- Development and testing — use the hosted Chaintracks instance or the bundled files
- If another Chaintracks instance is already available in your infrastructure

## Related

- [`@bsv/wallet-toolbox`](../packages/wallet/wallet-toolbox.md) — Chaintracks primitives defined here; toolbox wraps the client
- [BEEF (BRC-62)](../architecture/beef.md) — Merkle proofs that Chaintracks validates
- [Key Concepts: ARC and Chaintracks](../get-started/concepts.md#arc-and-chaintracks)
