---
id: spec-storage-adapter
title: Wallet Storage Adapter Interface
kind: spec
version: "1.0.0"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
status: stable
tags: ["spec", "wallet", "storage"]
---

# Wallet Storage Adapter Interface

> The Storage Adapter defines the HTTP boundary exposed by a remote wallet storage provider. Wallets can offload state to a remote server (via HTTPS) while keeping keys server-side. The adapter implements three storage layers: StorageReader (query-only), StorageReaderWriter (+ mutations), and StorageProvider (+ wallet operations).

## At a glance

| Field | Value |
|---|---|
| Format | OpenAPI 3.1 |
| Version | 1.0.0 |
| Status | stable |
| Implementations | @bsv/wallet-toolbox (client + local adapters) |

## What problem this solves

**Wallet scaling and multi-device access**. Local wallets (SQLite/IndexedDB) don't scale to thousands of transactions and don't sync across devices. Remote storage via HTTPS enables cloud wallets: keys stay server-side (hardware security), wallet state syncs automatically, and clients can be stateless (browser tabs, mobile apps).

**Pluggable storage backends**. Applications shouldn't care whether wallet data lives in SQLite, MySQL, PostgreSQL, IndexedDB, or a remote HTTPS server. The adapter defines a common interface so wallets can transparently swap backends without code changes.

**Privacy via HTTP boundaries**. Remote storage is protected by BRC-31 mutual authentication. Only authenticated clients (wallet owners) can read/write their data. The server never sees private keys (keys stay server-side in a key manager).

## Protocol overview

**Three-layer hierarchy**:

1. **StorageReader** — Read-only operations
   - `find(table, criteria)` — Query rows
   - `count(table, criteria)` — Count rows
   - Support for filtering, sorting, limits

2. **StorageReaderWriter** — Includes mutations
   - `insert(table, data)` — Add rows
   - `update(table, criteria, data)` — Modify rows
   - `delete(table, criteria)` — Remove rows
   - Transactional writes

3. **StorageProvider** — Includes wallet operations
   - `createAction(outputs)` — Build unsigned transaction
   - `signAction(reference)` — Sign transaction
   - `internalizeAction(tx)` — Import external transaction
   - Leverages tables from lower layers

**Tables** (examples from StorageReaderWriter):
- `actions` — Transaction history (created, pending, confirmed)
- `outputs` — UTXO state (unspent, spent, locked)
- `certificates` — Peer authentication proofs
- `permissions` — App permission grants

## Key types / endpoints

| Method | Path | Purpose | Request | Response |
|--------|------|---------|---------|----------|
| GET | `/storage/v1/settings` | Read configuration | (none) | `{ storageIdentityKey, chain, dbtype }` |
| GET | `/storage/v1/actions` | List transactions | `?basket=default&limit=100` | `[ { txid, status, created } ]` |
| POST | `/storage/v1/actions` | Create unsigned tx | `{ outputs: [...], description }` | `{ reference }` |
| POST | `/storage/v1/actions/{reference}/sign` | Sign transaction | `{ optionalCertificates }` | `{ signatures, tx }` |
| POST | `/storage/v1/actions/internalize` | Import external tx | `{ beef, description }` | `{ isMerge }` |
| GET | `/storage/v1/outputs` | List UTXOs | `?includeSpent=false` | `[ { txid, vout, satoshis, script } ]` |
| GET | `/storage/v1/certificates` | List certificates | (none) | `[ { cert } ]` |
| POST | `/storage/v1/permissions` | Grant app permission | `{ appId, protocolId, capability }` | OK |

All requests carry `x-bsv-auth-*` headers (BRC-31 mutual auth).

## Example: Remote wallet over HTTPS

```typescript
import { SetupClient } from '@bsv/wallet-toolbox'

// 1. Connect to remote wallet storage
const wallet = await SetupClient({
  endpointUrl: 'https://wallet-server.example.com',
  storageProvider: 'remote'  // Uses HTTP remote adapter
})

// 2. Create action (runs on server, keys stay server-side)
const action = await wallet.createAction({
  description: 'Send 10000 sats',
  outputs: [{
    satoshis: 10000,
    lockingScript: 'ab12...',
    outputDescription: 'payment'
  }]
})

// 3. Sign action (keys never leave server)
const signed = await wallet.signAction({
  actionReference: action.signableTransaction.reference
})

// 4. Submit to network (app decides)
await arc.broadcast(signed.tx)

// 5. Query wallet state from any device
const outputs = await wallet.listOutputs({
  includeSpent: false
})
```

## Conformance vectors

Storage Adapter conformance is tested in `conformance/vectors/wallet/storage/`:

- CRUD operations on all tables (actions, outputs, certificates, permissions)
- Query filtering and sorting
- Transaction atomicity (all-or-nothing writes)
- BRC-31 authentication on all endpoints
- Remote-local consistency (state syncs correctly)

## Implementations in ts-stack

| Package | Notes |
|---------|-------|
| @bsv/wallet-toolbox | Implements local adapters (KnexWalletStorage for SQLite/MySQL, IndexedDBWalletStorage for browser) and remote client (via HTTPS) |
| External: wallet-server | Reference storage server implementation (not in ts-stack; deploy separately) |

## Related specs

- [BRC-100 Wallet](./brc-100-wallet.md) — Wallet interface that this storage adapter implements
- [BRC-31 Auth](./brc-31-auth.md) — Authentication for remote storage endpoints

## Spec artifact

[storage-adapter.yaml](https://github.com/bsv-blockchain/ts-stack/blob/main/specs/wallet/storage-adapter.yaml)
