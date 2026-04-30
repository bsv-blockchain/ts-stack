---
id: spec-storage-adapter
title: Wallet Storage Adapter Interface
kind: spec
version: "1.0.0"
last_updated: "2026-04-30"
last_verified: "2026-04-30"
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
   - `createAction(outputs)` — Build and process wallet actions
   - `signAction(reference, spends)` — Complete a signable action with caller-supplied unlocking scripts
   - `internalizeAction(tx, outputs)` — Import external transaction outputs
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
| POST | `/storage/v1/actions/internalize` | Import external tx | `{ tx, outputs, description }` | `{ accepted }` |
| GET | `/storage/v1/outputs` | List outputs by basket/query | `?basket=default` | `[ { outpoint, satoshis, lockingScript } ]` |
| GET | `/storage/v1/certificates` | List certificates | (none) | `[ { cert } ]` |
| POST | `/storage/v1/permissions` | Grant app permission | `{ appId, protocolId, capability }` | OK |

All requests carry `x-bsv-auth-*` headers (BRC-31 mutual auth).

## Example: Remote wallet over HTTPS

```typescript
import { SetupClient } from '@bsv/wallet-toolbox'

// 1. Connect to remote wallet storage
const wallet = await SetupClient.createWalletClientNoEnv({
  chain: 'main',
  rootKeyHex: process.env.WALLET_ROOT_KEY_HEX!,
  storageUrl: 'https://store-us-1.bsvb.tech'
})

// 2. Create and process an action
const action = await wallet.createAction({
  description: 'Send 10000 sats',
  outputs: [{
    satoshis: 10000,
    lockingScript: 'ab12...',
    outputDescription: 'payment'
  }]
})

// 3. Query wallet state from any device using the same storage backend
const outputs = await wallet.listOutputs({
  basket: 'default',
  limit: 10
})
```

## Conformance vectors

There is no standalone storage-adapter vector directory in the current conformance corpus. Storage behavior is verified by wallet-toolbox package tests; portable wallet method fixtures currently live under `conformance/vectors/wallet/brc100/`.

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
