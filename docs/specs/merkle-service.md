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
import { Transaction, ARC, Merkle​Service } from '@bsv/sdk'

// 1. Submit transaction via ARC
const arc = new ARC()
const response = await arc.broadcast(tx)
const txid = response.txid

// 2. Register callback with Merkle Service
const merkleService = new MerkleService('https://merkle.example.com')
await merkleService.watch({
  txid,
  callbackUrl: 'https://yourapp.com/merkle-callback'
})

// 3. Wait for callback
// Server receives POST /merkle-callback with { txid, merkleProof, blockHeight, ... }
```

Server-side callback handler:

```typescript
app.post('/merkle-callback', async (req, res) => {
  const { txid, merkleProof, blockHeight, blockHash } = req.body
  
  // Verify proof (SPV)
  const isValid = await verifyMerkleProof(txid, merkleProof, blockHash)
  
  if (isValid) {
    // Store proof and update transaction status to "confirmed"
    await wallet.markTransactionConfirmed(txid, merkleProof, blockHeight)
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
| @bsv/sdk | `MerkleService` client class for registering transactions and handling callbacks |
| @bsv/wallet-toolbox | Integrates Merkle Service for obtaining proofs during transaction confirmation |
| External: Go Merkle Service | Reference implementation (not in ts-stack; run separately) |

## Related specs

- [ARC Broadcast](./arc-broadcast.md) — Alternative way to receive merkle proofs (via callback URL in initial submission)
- [BRC-95 / BRC-62](https://github.com/bitcoin-sv/BRCs/blob/master/transactions/0095.md) — Merkle proof formats (BUMP, Merkle branch)

## Spec artifact

[merkle-service-http.yaml](https://github.com/bsv-blockchain/ts-stack/blob/main/specs/merkle/merkle-service-http.yaml)
