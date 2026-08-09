---
id: infra-chaintracks-server
title: 'Chaintracks Server'
kind: infra
version: '1.1.0'
last_updated: '2026-08-05'
last_verified: '2026-08-05'
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
- Tracks `main`, `test`, `stn`, `ttn`, and `tstn` with distinct validated genesis headers
- Uses credential-free Arcade/go-chaintracks bulk and SSE sources before the optional WhatsOnChain fallback

## Startup and Bootstrap

On first start, Chaintracks must acquire all existing BSV block headers before serving SPV queries. The bootstrap sequence:

1. **Retained/bundled files** — Previously validated local files remain the fastest and most independent bootstrap source.
2. **CDN bulk ingest** — `SOURCE_CDN_URL` supplies immutable bulk files. Set it to an empty string to disable this source without changing older deployments that rely on the default.
3. **Arcade/go-chaintracks** — The server fetches bounded binary header batches and follows the reconnecting tip SSE stream. Public defaults exist for mainnet, testnet, and TerraTestNet; STN and Terra Scaling TestNet require an operator endpoint.
4. **WhatsOnChain fallback** — Mainnet and testnet only. No key is required: anonymous requests are serialized below the documented three requests/second limit. A key can raise the allowance, but a rejected key is retried anonymously instead of making ChainTracks unavailable.

Every remote batch still passes through ChainTracks' local serialization, hash,
continuity, and genesis checks before storage. When every provider is
temporarily unavailable, a synchronized process continues serving its
last-good checked height and headers and exposes degraded source state from
`getInfo`/`readyz`.

Arcade is the HTTPS/SSE gateway used by browser, mobile, local, and service deployments and may itself be backed by Teranode P2P. This TypeScript server does not open a direct Teranode P2P session; adding one would require a separately reviewed server-only adapter and must not enter browser bundles. <!-- audio: Chaintracks server.m4a @ 00:40 -->

## API

Two API surfaces are mounted on the same port (default `3011`):

### v1 (JSON, legacy)

| Method | Path                                | Purpose                                                |
| ------ | ----------------------------------- | ------------------------------------------------------ |
| GET    | `/getChain`                         | Network name (`main`, `test`, `stn`, `ttn`, or `tstn`) |
| GET    | `/getInfo`                          | Service state: heights, storage backend, ingestors     |
| GET    | `/getPresentHeight`                 | Latest external blockchain height                      |
| GET    | `/findChainTipHashHex`              | Active chain tip hash                                  |
| GET    | `/findChainTipHeaderHex`            | Active chain tip header                                |
| GET    | `/findHeaderHexForHeight?height=N`  | Header at height                                       |
| GET    | `/findHeaderHexForBlockHash?hash=H` | Header for hash (live storage)                         |
| GET    | `/getHeaders?height=N&count=M`      | Concatenated 80-byte hex header batch                  |
| GET    | `/getFiatExchangeRates`             | BSV fiat exchange rates                                |
| POST   | `/addHeaderHex`                     | Submit a new block header for processing               |

### v2 (RESTful, JSON + binary)

Mirrors the `go-chaintracks` v2 contract. All responses use the `{status, value}` / `{status, code, description}` envelope; binary variants return raw 80-byte headers with `X-Block-Height` / `X-Start-Height` / `X-Header-Count` headers.

| Method | Path                               | Purpose                                      |
| ------ | ---------------------------------- | -------------------------------------------- |
| GET    | `/v2/network`                      | Network name                                 |
| GET    | `/v2/height`                       | Present height                               |
| GET    | `/v2/tip`                          | Chain tip header (JSON)                      |
| GET    | `/v2/tip/stream`                   | Reconnecting-compatible SSE tip stream       |
| GET    | `/v2/reorg/stream`                 | SSE reorganization stream                    |
| GET    | `/v2/tip.bin`                      | Chain tip header (80-byte binary)            |
| GET    | `/v2/header/height/:height`        | Header at height (JSON)                      |
| GET    | `/v2/header/height/:height.bin`    | Header at height (binary)                    |
| GET    | `/v2/header/hash/:hash`            | Header by hash (JSON)                        |
| GET    | `/v2/header/hash/:hash.bin`        | Header by hash (binary)                      |
| GET    | `/v2/headers?height=N&count=M`     | Header batch (binary, JSON envelope omitted) |
| GET    | `/v2/headers.bin?height=N&count=M` | Header batch (binary)                        |

The v2 surface is exercised by the [`sync.chaintracks-v2-http`](../conformance/index.md) conformance vectors so cross-language implementations (`go-chaintracks`, future Rust/Python ports) can be validated against the same contract. <!-- audio: Chaintracks server.m4a @ 03:40 -->

## Configuration

```bash
PORT=3011                                  # HTTP listen port
CHAIN=main                                 # main | test | stn | ttn | tstn
SOURCE_CDN_URL=https://cdn.projectbabbage.com/blockheaders/
CHAINTRACKS_UPSTREAM_URL=                  # optional override; "disabled" disables
CHAINTRACKS_UPSTREAM_API_PREFIX=           # inferred as /chaintracks/v2 by default
CHAINTRACKS_UPSTREAM_MAX_HEADERS=1000
CHAINTRACKS_DISABLE_WHATSONCHAIN=false      # main/test fallback only
WHATSONCHAIN_API_KEY=                       # optional, never required
STN_ARCADE_URL=                             # optional STN v2 host
STN_CHAINTRACKS_URL=                        # optional STN v2 ChainTracks URL
TSTN_ARCADE_URL=                            # optional TSTN v2 host
TSTN_CHAINTRACKS_URL=                       # optional TSTN v2 ChainTracks URL
ROUTING_PREFIX=                             # optional mount prefix; /healthz stays at root
```

For `stn` or `tstn`, set `CHAINTRACKS_UPSTREAM_URL` (or the corresponding
`STN_ARCADE_URL`, `STN_CHAINTRACKS_URL`, `TSTN_ARCADE_URL`, or
`TSTN_CHAINTRACKS_URL`) to an operator-controlled Arcade or go-chaintracks v2
service. The server fails closed rather than aliasing either network to testnet.

`GET /healthz` is the process liveness endpoint. `GET /readyz` (under
`ROUTING_PREFIX` when configured) verifies that ChainTracks is listening and
can report a locally or remotely sourced height; it also includes source health.

Public browser access is enabled by default. Use
`CHAINTRACKS_CORS_MODE=allowlist` and
`CHAINTRACKS_CORS_ALLOWED_ORIGINS` only for a deployment with a closed browser
caller set. Omit `CHAINTRACKS_CORS_ALLOWED_HEADERS` and
`CHAINTRACKS_CDN_CORS_ALLOWED_HEADERS` for additive well-formed preflight
header compatibility; set exact comma-separated lists only for a strict
browser header allowlist. API JSON bodies are capped at 256 KiB, the optional bulk CDN has a
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
