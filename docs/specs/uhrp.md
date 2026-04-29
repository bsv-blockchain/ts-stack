---
id: spec-uhrp
title: UHRP — Universal Hash Resolution Protocol
kind: spec
version: "1.0.0"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
status: stable
tags: ["spec", "storage", "content-addressed", "uhrp"]
---

# UHRP — Universal Hash Resolution Protocol

> UHRP (BRC-26) enables content-addressed file storage on BSV. Files are identified and retrieved by their SHA-256 hash, not by path. A UHRP server stores files and publishes availability advertisements on the overlay network (`tm_uhrp` topic). Clients discover storage locations and verify file integrity by hash.

## At a glance

| Field | Value |
|---|---|
| Format | OpenAPI 3.1 |
| Version | 1.0.0 |
| Status | stable |
| Implementations | @bsv/overlay-topics (tm_uhrp topic manager) |

## What problem this solves

**Permanent, hash-addressed file storage**. Traditional URLs break when servers move. UHRP uses SHA-256 hash as permanent file ID: `uhrp://abc123...` always refers to the same content. Any server can host the file; clients verify integrity by hashing the retrieved data.

**Decentralized availability**. Files are mirrored across multiple UHRP servers. Clients query the overlay network (`ls_uhrp` lookup service) to find all hosts with a given hash, then download from any available server. No single point of failure.

**Peer discovery via overlay**. UHRP servers publish availability advertisements to the overlay's `tm_uhrp` topic. These advertisements record file hash, size, expiry, and download URLs. The `ls_uhrp` lookup service indexes these advertisements, enabling instant discovery.

## Protocol overview

**Three-phase flow** (upload → advertise → retrieve):

**Phase 1 — Upload File**

1. **Client → UHRP Server** `POST /upload`
   - File binary data (raw bytes)
   - Server computes SHA-256 hash
   - Returns: UHRP URL (`uhrp://hash...`) and metadata

2. **UHRP Server** stores file and generates advertisement

**Phase 2 — Publish to Overlay**

3. **UHRP Server → Overlay** (via `POST /submit`)
   - PushDrop transaction tagged with `tm_uhrp` topic
   - Advertisement contains: hash, file size, download URL, expiry timestamp
   - Overlay records admission; `ls_uhrp` lookup service indexes it

**Phase 3 — Retrieve File**

4. **Client → Overlay** `POST /lookup`
   - Query: `{ service: "ls_uhrp", query: { hash: "abc123..." } }`
   - Lookup service returns: array of servers hosting the file

5. **Client → UHRP Server** `GET /{hash}`
   - Downloads file from any available server
   - Verifies SHA-256 matches requested hash
   - Rejects file if hash doesn't match

## Key types / endpoints

| Method | Path | Purpose | Request | Response |
|--------|------|---------|---------|----------|
| POST | `/upload` | Upload file | Binary file data | `{ hash, uhrpUrl, size, expiryTimestamp }` |
| GET | `/{hash}` | Download file | (none) | Binary file data + `Content-Hash` header |
| HEAD | `/{hash}` | Check availability | (none) | `200 OK` + `Content-Hash` header |
| GET | `/info/{hash}` | Get metadata | (none) | `{ hash, size, expiryTimestamp, hosts: [...] }` |

**Overlay integration**:
- `tm_uhrp` topic manager — Validates UHRP advertisements
- `ls_uhrp` lookup service — Queries for files by hash; returns host list

## Example: Upload and retrieve file

```typescript
import { StorageUploader, StorageDownloader } from '@bsv/sdk'

// 1. Upload file to UHRP server
const uploader = new StorageUploader('https://uhrp-server.example.com')
const file = Buffer.from('Hello, UHRP!')
const result = await uploader.upload(file)

console.log('File stored at:', result.uhrpUrl)  // uhrp://abc123...

// 2. Publish advertisement to overlay (server does this automatically)
// UHRP server issues a PushDrop transaction to tm_uhrp topic

// 3. Retrieve file later (from any server)
const downloader = new StorageDownloader()
const retrieved = await downloader.download(result.hash)

// 4. Verify integrity
const hash = sha256(retrieved)
if (hash === result.hash) {
  console.log('File verified!')
} else {
  console.log('Hash mismatch - file corrupted or incorrect')
}
```

Example: Query overlay for file locations

```typescript
const overlayClient = new OverlayClient('https://overlay.example.com')

// 1. Find all servers hosting a file
const locations = await overlayClient.lookup({
  service: 'ls_uhrp',
  query: { hash: 'abc123...' }
})

console.log('File available at:', locations.urls)
// [ 'https://server1.com/abc123...', 'https://server2.com/abc123...' ]

// 2. Download from fastest/closest server
const downloaded = await fetch(locations.urls[0])
const data = await downloaded.arrayBuffer()
```

## Conformance vectors

UHRP conformance is tested in `conformance/vectors/storage/uhrp/`:

- File upload and hash computation
- SHA-256 hash verification on download
- Advertisement publication and overlay indexing
- Lookup service correctness (returns all hosts for a hash)
- Expiry timestamp handling

## Implementations in ts-stack

| Package | Notes |
|---------|-------|
| @bsv/overlay-topics | `UHRPTopicManager` (validates advertisements), `createUHRPLookupService` (indexes hashes) |
| @bsv/sdk | `StorageUploader`, `StorageDownloader` client classes |

## Related specs

- [Overlay HTTP](./overlay-http.md) — Overlay network where UHRP advertisements are published
- [BRC-26](../../../docs/BRCs/storage/0026.md) — Full UHRP specification

## Spec artifact

[uhrp-http.yaml](https://github.com/bsv-blockchain/ts-stack/blob/main/specs/storage/uhrp-http.yaml)
