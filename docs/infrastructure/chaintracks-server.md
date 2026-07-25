---
id: infra-chaintracks-server
title: "Chaintracks Server"
kind: infra
version: "1.0.10"
last_updated: "2026-07-25"
last_verified: "2026-07-25"
review_cadence_days: 30
status: stable
tags: [chaintracks, block-headers, spv, merkle, infrastructure]
---

# Chaintracks Server

Chaintracks Server is the reference implementation for BSV block header management. It maintains a complete chain of block headers and exposes a REST API for header lookup and Merkle proof validation — the header-side half of Simplified Payment Verification (SPV). Source lives in [`infra/chaintracks-server`](https://github.com/bsv-blockchain/ts-stack/tree/main/infra/chaintracks-server). <!-- audio: Chaintracks server.m4a @ 00:00 -->

The Chaintracks primitives and client interface are defined in `@bsv/wallet-toolbox`. This server is the Express deployment wrapper around `ChaintracksService` from that package.

## What it does

- Wraps `ChaintracksService` from `@bsv/wallet-toolbox` behind an Express HTTP server
- Maintains a chain of headers from genesis to the current tip via bulk + live ingestors
- Exposes JSON v1 (legacy) and v2 (RESTful, with binary variants) APIs
- Provides bulk header download in concatenated 80-byte format for SPV clients

## Startup and Bootstrap

On first start, Chaintracks must acquire all existing BSV block headers before serving SPV queries. The bootstrap sequence:

1. **Bundled files** — Repository ships with bulk header files. Used for initial ingest when no CDN URL is configured.
2. **CDN bulk ingest** — If `CHAINTRACKS_CDN_URL` is set (typically another running Chaintracks server), headers are fetched in 100,000-block batches. Fastest path.
3. **WhatsOnChain bulk ingester** — Fallback when bundled files and CDN are unavailable.
4. **Live tip sync** — Once bulk headers are loaded, switches to live mode via Teranode P2P or the WhatsOnChain live ingester. <!-- audio: Chaintracks server.m4a @ 00:40 -->

## API

Two API surfaces are mounted on the same port (default `3011`):

### v1 (JSON, legacy)

| Method | Path | Purpose |
|---|---|---|
| GET | `/getChain` | Network name (`main` or `test`) |
| GET | `/getInfo` | Service state: heights, storage backend, ingestors |
| GET | `/getPresentHeight` | Latest external blockchain height |
| GET | `/findChainTipHashHex` | Active chain tip hash |
| GET | `/findChainTipHeaderHex` | Active chain tip header |
| GET | `/findHeaderHexForHeight?height=N` | Header at height |
| GET | `/findHeaderHexForBlockHash?hash=H` | Header for hash (live storage) |
| GET | `/getHeaders?height=N&count=M` | Concatenated 80-byte hex header batch |
| GET | `/getFiatExchangeRates` | BSV fiat exchange rates |
| POST | `/addHeaderHex` | Submit a new block header for processing |

### v2 (RESTful, JSON + binary)

Mirrors the `go-chaintracks` v2 contract. All responses use the `{status, value}` / `{status, code, description}` envelope; binary variants return raw 80-byte headers with `X-Block-Height` / `X-Start-Height` / `X-Header-Count` headers.

| Method | Path | Purpose |
|---|---|---|
| GET | `/v2/network` | Network name |
| GET | `/v2/tip` | Chain tip header (JSON) |
| GET | `/v2/tip.bin` | Chain tip header (80-byte binary) |
| GET | `/v2/header/height/:height` | Header at height (JSON) |
| GET | `/v2/header/height/:height.bin` | Header at height (binary) |
| GET | `/v2/header/hash/:hash` | Header by hash (JSON) |
| GET | `/v2/header/hash/:hash.bin` | Header by hash (binary) |
| GET | `/v2/headers?height=N&count=M` | Header batch (binary, JSON envelope omitted) |
| GET | `/v2/headers.bin?height=N&count=M` | Header batch (binary) |

The v2 surface is exercised by the [`sync.chaintracks-v2-http`](../conformance/index.md) conformance vectors so cross-language implementations (`go-chaintracks`, future Rust/Python ports) can be validated against the same contract. <!-- audio: Chaintracks server.m4a @ 03:40 -->

## Configuration

```bash
PORT=3011                                  # HTTP listen port
CHAIN=main                                 # main | test
CHAINTRACKS_CDN_URL=https://chaintracks-us-1.bsvb.tech   # CDN bootstrap source
WHATS_ON_CHAIN_LIVE=true                   # Use WhatsOnChain live ingester instead of Teranode
```

Teranode P2P live ingest requires bootstrap peer configuration.

Public browser access is enabled by default. Use
`CHAINTRACKS_CORS_MODE=allowlist` and
`CHAINTRACKS_CORS_ALLOWED_ORIGINS` only for a deployment with a closed browser
caller set. API JSON bodies are capped at 256 KiB, the optional bulk CDN has a
separate concurrency/timeout policy, and all responses receive the shared
security-header baseline. See
[Public Service Edge Security](service-edge-security.md#chaintracks-server-and-reusable-chaintracksservice).

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
