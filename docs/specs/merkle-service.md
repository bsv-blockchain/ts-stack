---
id: spec-merkle-service
title: Merkle Service API
kind: spec
version: "1.0.0"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
status: stable
tags: ["spec", "merkle", "spv"]
---

# Merkle Service API

> The Merkle Service is a Go microservice that accepts transaction IDs and monitors the blockchain for Merkle proofs. When a transaction is confirmed in a block, the service delivers the SPV proof (BUMP format) to a registered callback URL. Clients use it to obtain proofs without running a full node or polling repeatedly.

## At a glance

| Field | Value |
|---|---|
| Format | OpenAPI 3.1 |
| Version | 1.0.0 |
| Status | stable |
| Implementations | @bsv/sdk (client), external Go microservice |

## What problem this solves

**Simplified SPV without full node**. Wallets need Merkle proofs to verify transaction inclusion without downloading full blocks. Running a full node is expensive. The Merkle Service monitors the blockchain (either running a node itself or querying public data sources) and delivers proofs to clients on demand.

**Callback-based delivery**. Instead of polling the service repeatedly ("is my transaction confirmed yet?"), clients register a callback URL once. The service delivers the proof automatically when confirmation occurs, reducing network traffic and latency.

**Idempotent registration**. Registering the same transaction ID multiple times with the same callback is safe; the service deduplicates internally. This simplifies client logic (no need to track registrations).

## Protocol overview

**Register transaction for monitoring**:

1. **Client → Merkle Service** `POST /watch`
   - Transaction ID (64-char hex string)
   - Callback URL (HTTPS endpoint to receive proof)

2. **Merkle Service** (monitoring)
   - Watches blockchain for transaction confirmation
   - When block arrives, extracts Merkle proof in BUMP format
   - Makes HTTP POST to registered callback URL with proof

3. **Client** (receives callback)
   - Validates BUMP proof against transaction ID
   - Uses proof for SPV verification

**Health check**:

- `GET /health` — Returns OK if Merkle Service is connected to blockchain data source (Aerospike)

## Key types / endpoints

| Method | Path | Purpose | Request | Response |
|--------|------|---------|---------|----------|
| POST | `/watch` | Register transaction for merkle proof | `{ txid, callbackUrl }` | `{ status: "OK" }` |
| GET | `/health` | Health check | (none) | `{ status: "OK" }` or error |

**Request body** (`POST /watch`):
- `txid: string` — Transaction ID (64 hex characters, case-insensitive)
- `callbackUrl: string` — HTTPS URL to POST proof to (must be valid HTTPS)

**Response body** (callback POST):
- `txid: string` — Transaction ID
- `merkleProof: string` — BUMP format (Base64 or hex, spec-dependent)
- `blockHeight: number` — Block height of confirmation
- `blockHash: string` — Block hash (64-char hex)
- `timestamp: number` — Block timestamp (Unix seconds)

**Error responses** (400, 404, etc.):
- Invalid txid format → 400 Bad Request
- Invalid callback URL → 400 Bad Request
- Service offline → 503 Service Unavailable

## Example: Monitor transaction

```typescript
import { Transaction, WhatsOnChain } from '@bsv/sdk'

// Parse an example BEEF transaction that already includes a merkle path.
const tx = Transaction.fromHexBEEF('0100beef01fe87730e000402070282f861969...')

const txid = tx.id('hex')
const chaintracker = new WhatsOnChain()
const onChain = await tx.merklePath.verify(txid, chaintracker)

if (onChain) console.log('This transaction is proven on chain with SPV.')
```

Server-side callback handler:

```typescript
import { MerklePath, WhatsOnChain } from '@bsv/sdk'

app.post('/merkle-callback', async (req, res) => {
  const { txid, merkleProof, blockHeight, blockHash } = req.body

  const merklePath = MerklePath.fromHex(merkleProof)
  const chaintracker = new WhatsOnChain()
  const isValid = await merklePath.verify(txid, chaintracker)

  if (isValid) {
    await saveMerkleProof({ txid, merkleProof, blockHeight, blockHash })
  }

  res.json({ status: 'received' })
})
```

## Conformance vectors

Merkle Service conformance is tested in `conformance/vectors/merkle/`:

- Transaction ID validation (format, case-insensitivity)
- Callback URL validation (HTTPS-only)
- Idempotent registration (duplicate txid + url)
- Proof format validation (BUMP structure)
- Callback delivery timing

## Implementations in ts-stack

| Package | Notes |
|---------|-------|
| @bsv/sdk | `Transaction`, `MerklePath`, and `WhatsOnChain` helpers for SPV verification |
| @bsv/wallet-toolbox | Integrates Merkle Service for obtaining proofs during transaction confirmation |
| External: Go Merkle Service | Reference implementation (not in ts-stack; run separately) |

## Related specs

- [ARC Broadcast](./arc-broadcast.md) — Alternative way to receive merkle proofs (via callback URL in initial submission)
- [BRC-95 / BRC-62](https://github.com/bitcoin-sv/BRCs/blob/master/transactions/0095.md) — Merkle proof formats (BUMP, Merkle branch)

## Spec artifact

[merkle-service-http.yaml](https://github.com/bsv-blockchain/ts-stack/blob/main/specs/merkle/merkle-service-http.yaml)
