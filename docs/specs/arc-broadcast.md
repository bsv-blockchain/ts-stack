---
id: spec-arc-broadcast
title: ARC Broadcast API
kind: spec
version: "1.0.0"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
status: stable
tags: ["spec", "broadcast", "arc"]
---

# ARC Broadcast API

> ARC (Authoritative Response Component) is the miner-facing transaction broadcast service. Clients submit raw transactions or batches to ARC nodes, receive structured responses with transaction status codes, and can optionally register callbacks for Merkle proof delivery when transactions confirm.

## At a glance

| Field | Value |
|---|---|
| Format | OpenAPI 3.1 |
| Version | 1.0.0 |
| Status | stable |
| Implementations | @bsv/sdk |

## What problem this solves

**Direct miner communication**. Wallets and applications need to submit transactions to miners efficiently, with immediate feedback on whether the transaction was accepted, rejected, or is a double-spend. ARC provides a direct REST API to miner networks without going through third-party nodes.

**Structured status codes**. ARC returns standardized response codes (`SENT_TO_NETWORK`, `CONFIRMED`, `DOUBLE_SPEND_ATTEMPTED`, `REJECTED`, etc.) so clients can programmatically determine success vs. failure. This is better than generic HTTP status codes.

**Callback-based merkle proof delivery**. Instead of polling for merkle proofs, clients register a callback URL when submitting a transaction. ARC delivers the proof via HTTP POST when the transaction confirms, reducing latency and network traffic.

## Protocol overview

**Transaction submission and status tracking**:

1. **Client → ARC** `POST /v1/tx`
   - Raw transaction (hex format, optionally Extended Format)
   - `Authorization: Bearer <apiKey>` (if required)
   - Optional `X-CallbackUrl` and `X-CallbackToken` for proof delivery
   - Optional `XDeployment-ID` for request tracking

2. **ARC → Client** HTTP 200 response
   - JSON object with `txid`, `txStatus`, `extraInfo`
   - Status indicates success, double-spend, rejection, etc.

3. **Client polls or waits** for confirmation
   - Via optional callback delivery: ARC posts merkle proof to `X-CallbackUrl`
   - Via polling: Client can re-submit txid to ARC for status updates

**Status codes** (from ARC response):

- `SENT_TO_NETWORK` — Transaction accepted and forwarded to miners
- `CONFIRMED` — Transaction included in a block
- `DOUBLE_SPEND_ATTEMPTED` — Input already spent by another transaction
- `REJECTED` — Transaction failed validation (invalid script, insufficient fees, etc.)
- `INVALID` — Malformed transaction
- `MINED_IN_STALE_BLOCK` — Included in a block that was later orphaned

## Key types / endpoints

| Method | Path | Purpose | Request | Response |
|--------|------|---------|---------|----------|
| POST | `/v1/tx` | Submit transaction | `{ rawTx: hexString }` | `{ txid, txStatus, extraInfo }` |
| POST | `/v1/txs` | Batch submit | `[ { rawTx }, ... ]` | `[ { txid, txStatus } ]` |
| GET | `/v1/tx/{txid}` | Query status (if supported) | (none) | `{ txid, txStatus, confirmations }` |

**Request headers**:
- `Authorization: Bearer <apiKey>` — API authentication (if configured)
- `X-CallbackUrl` — HTTP URL to POST merkle proof (optional)
- `X-CallbackToken` — Token to include in callback request (optional)
- `XDeployment-ID` — Request tracking ID (optional)

**Response body**:
- `txid: string` — Transaction ID (64-char hex)
- `txStatus: string` — Status code (see above)
- `extraInfo: string` — Additional details (e.g., competing txids for double-spend)
- `competingTxs?: string[]` — Array of conflicting txids (if double-spend)

## Example: Submit transaction with SDK

```typescript
import { Transaction, ARC } from '@bsv/sdk'

// 1. Load a signed transaction. BEEF is preferred when the source
// transaction data is available because ARC can receive Extended Format.
const tx = Transaction.fromHexBEEF('0100beef01fe87730e000402070282f861969...')

// 2. Create ARC broadcaster with optional callback
const arc = new ARC('https://arc.example.com', {
  apiKey: 'your-arc-api-key',
  callbackUrl: 'https://yourapp.com/arc-callback',
  callbackToken: 'secret-token-for-validation'
})

// 3. Submit to ARC
const response = await arc.broadcast(tx)

if (response.status === 'success') {
  console.log('Transaction accepted:', response.txid)
} else if (response.code === 'DOUBLE_SPEND_ATTEMPTED') {
  console.log('Double-spend detected:', response.more?.competingTxs)
} else {
  console.log('Broadcast failed:', response.code, response.description)
}
```

Example: Callback handling

Server receives POST to `X-CallbackUrl`:

```typescript
// POST /arc-callback
app.post('/arc-callback', async (req, res) => {
  const { txid, merkleProof, blockHash, blockHeight } = req.body
  
  // Validate token
  if (req.headers['x-callback-token'] !== 'secret-token-for-validation') {
    return res.status(401).send('Unauthorized')
  }
  
  // Store proof and update wallet state
  await saveMerkleProof({ txid, merkleProof, blockHash, blockHeight })
  
  res.json({ status: 'received' })
})
```

## Conformance vectors

ARC conformance is tested in `conformance/vectors/broadcast/arc/`:

- Transaction format validation (raw hex, Extended Format)
- Status code correctness (accepted vs. rejected)
- Double-spend detection
- Callback delivery on confirmation
- API key authentication

## Implementations in ts-stack

| Package | Notes |
|---------|-------|
| @bsv/sdk | `ARC` broadcaster class; handles submission and status polling |
| @bsv/wallet-toolbox | Integrates ARC for transaction broadcast; handles callback receipt |

## Related specs

- [Merkle Service](./merkle-service.md) — Alternative proof delivery (Go microservice)
- [BRC-95 / BRC-62](https://github.com/bitcoin-sv/BRCs/blob/master/transactions/0095.md) — Transaction format (raw hex, Extended Format, BEEF)

## Spec artifact

[arc.yaml](https://github.com/bsv-blockchain/ts-stack/blob/main/specs/broadcast/arc.yaml)
