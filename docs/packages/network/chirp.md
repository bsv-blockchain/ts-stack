---
id: chirp
title: '@bsv/chirp'
kind: package
domain: network
npm: '@bsv/chirp'
version: '0.1.1'
last_updated: '2026-08-27'
last_verified: '2026-08-27'
review_cadence_days: 30
repo: 'https://github.com/bsv-blockchain/ts-stack/tree/main/packages/network/chirp'
status: experimental
tags: ['network', 'storage', 'uhrp', 'merkle', 'brc-167']
---

# @bsv/chirp

> Browser- and Node-compatible BRC-167 reference implementation for progressively publishing and resiliently resolving large UHRP-addressed byte streams.

## Install

```bash
npm install @bsv/chirp @bsv/sdk
```

## Quick start

```typescript
import { CHIRPUploader, CHIRPDownloader } from '@bsv/chirp'

const publication = await new CHIRPUploader({
  wallet,
  storageURLs: ['https://storage-a.example', 'https://storage-b.example'],
  resilienceLevel: 2
}).publish({
  source: file.stream(),
  logicalLength: file.size,
  retentionSeconds: 2_592_000,
  mediaType: file.type || undefined
})

const downloader = new CHIRPDownloader({ concurrency: 4 })
for await (const chunk of downloader.stream(publication.chirpURL)) {
  consume(chunk.data)
}
```

## What it provides

- Canonical CHIRP v1 root and branch codecs, CompactSize handling, and portable golden vectors
- Deterministic profile 1 construction with 4 MiB blobs and fanout 256
- Progressive publication to one or more authenticated storage hosts, including resumable checkpoints
- UHRP root discovery through the existing `ls_uhrp` service
- Lazy logical-range traversal, bounded concurrency and retries, and per-object host interleaving
- SHA-256 verification before releasing blobs and terminal `contentHash` verification for complete streams
- Complete-closure validation, verified-object caching, OpenAPI metadata, and a `chirp` CLI
- Browser `Blob` and `ReadableStream` plus Node `AsyncIterable` byte-source adapters

## Compatibility

CHIRP is additive. It does not change `StorageUploader`, `StorageDownloader`,
`StorageUtils`, `uhrp:` identifiers, `tm_uhrp`, `ls_uhrp`, or existing storage-
server routes. The maintained filesystem and cloud-bucket servers expose CHIRP
under `/chirp/v1` and publish roots as ordinary BRC-26 advertisements only
after validating the complete transitive closure.

The package reports `profileCanonical: false` when it safely resolves a future
chunking profile whose profile-specific construction it cannot yet validate.
Unknown critical extensions and unsupported node or child kinds fail closed.

## Operational and security notes

- Verified chunks may be consumed before a final complete-stream hash check;
  use `download()` or another atomic sink when early consumption is unsafe.
- `mediaType` is untrusted advisory metadata and does not authorize rendering
  or execution.
- Resume checkpoints contain authenticated staging capabilities and should be
  stored with user-private permissions.
- Requests, responses, retries, object counts, logical size, depth, cache use,
  and concurrency are bounded. Server-side consumers should provide a DNS- and
  environment-aware `urlPolicy`; the CLI rejects non-public DNS by default.
- Ordinary UHRP advertisements mean complete hosting. Partial-host coverage,
  media-aware profiles, proofs, collections, and erasure coding remain reserved
  for later compatible specifications.

## CLI

```bash
chirp publish ./large.bin --host https://storage.example \
  --wallet-module ./wallet.mjs --retention-seconds 2592000
chirp retrieve chirp://... --output ./large.bin --range 0:4194304
chirp verify chirp://...
```

## Reference

- [Package README](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/network/chirp#readme)
- [BRC-167 proposal](https://github.com/bsv-blockchain/BRCs/pull/235)
- [Source on GitHub](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/network/chirp)
- [npm](https://www.npmjs.com/package/@bsv/chirp)
