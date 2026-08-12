---
id: infra-chaintracks-server
title: 'Chaintracks Server'
kind: infra
version: '1.2.0'
last_updated: '2026-08-12'
last_verified: '2026-08-12'
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

1. **Probe listeners and active startup** — The server binds constant-time
   liveness/readiness endpoints, explicitly starts ChainTracks synchronization,
   and keeps readiness at `503` until the tracker becomes available. A normal
   API request is never required to unblock a Kubernetes rollout.
2. **Retained/bundled files** — Local immutable objects are consulted before
   the network and revalidated for length, digest, linkage, chain work,
   genesis, and proof of work before first use.
3. **CDN bulk ingest** — `SOURCE_CDN_URL` supplies immutable bulk files. Set it to an empty string to disable this source without changing older deployments that rely on the default.
4. **Arcade/go-chaintracks** — The server fetches bounded binary header batches and follows the reconnecting tip SSE stream. Public defaults exist for mainnet, testnet, and TerraTestNet; STN and Terra Scaling TestNet require an operator endpoint.
5. **WhatsOnChain fallback** — Mainnet and testnet only. No key is required: anonymous requests are serialized below the documented three requests/second limit. A key can raise the allowance, but a rejected key is retried anonymously instead of making ChainTracks unavailable.

Every remote batch still passes through ChainTracks' local serialization, hash,
continuity, genesis, chain-work, and proof-of-work checks before storage.
Concurrent misses for one immutable object share one request; retry and body
limits are enforced in one layer; a durable remote-byte ledger reserves the
full object before every physical attempt; and successful objects are
content-addressed and atomically persisted. Complete-object validation runs in
a bounded Node worker pool, so normal requests and probes do not share its CPU
work. When every provider is
temporarily unavailable, a synchronized process continues serving its
last-good checked height and headers and exposes degraded source state from
`getInfo`/`readyz`.

Rejected cache objects move to quarantine instead of being unlinked. Legacy
flat files are read during migration and promoted only after complete
validation. CDN files publish as a complete generation behind an atomic
`current` pointer; the last three generations remain available for rollback.
A process crash during download, validation, export, or pointer publication
therefore leaves the last-good generation and its content-addressed objects in
place.

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
CHAINTRACKS_BULK_FILE_CACHE=true             # set false only for ephemeral development
CHAINTRACKS_UPSTREAM_DOWNLOAD_MAX_BYTES_PER_HOUR=536870912
CHAINTRACKS_VALIDATION_WORKERS=1
CHAINTRACKS_VALIDATION_QUEUE_MAX=8
CHAINTRACKS_HISTORICAL_RATE_LIMIT_WINDOW_MS=60000
CHAINTRACKS_HISTORICAL_RATE_LIMIT_MAX=600
CHAINTRACKS_HISTORICAL_MAX_CONCURRENT_REQUESTS=8
TRUST_PROXY_HOPS=                            # opt in only behind trusted proxies
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

Chaintracks Server 1.1.12 is the first deployable resilient image after the
protected `@bsv/wallet-toolbox` 2.9.0 publication and standalone lockfile
reconciliation. Version 1.1.10 preceded that reconciliation; staging rejected
1.1.11 because synchronization did not start until a normal API request
arrived. Production startup must log `resilient_bulk_runtime_active: true` and
the `readiness` operation must complete successfully.

`GET /healthz` and `GET /readyz` are local, constant-time endpoints registered
before public request admission. Both remain available at the root and under
`ROUTING_PREFIX`. Readiness uses an in-memory availability snapshot and never
refreshes a provider, reads storage, or starts validation. The snapshot exposes
last-good height freshness, refresh state, source state, cache counters, worker
queue/duration counters, durable budget remaining, and sampled event-loop lag.

Public browser access is enabled by default. Use
`CHAINTRACKS_CORS_MODE=allowlist` and
`CHAINTRACKS_CORS_ALLOWED_ORIGINS` only for a deployment with a closed browser
caller set. Omit `CHAINTRACKS_CORS_ALLOWED_HEADERS` and
`CHAINTRACKS_CDN_CORS_ALLOWED_HEADERS` for additive well-formed preflight
header compatibility; set exact comma-separated lists only for a strict
browser header allowlist. Historical height and batch routes also have a
separate process-local rate limit and concurrency queue; horizontally scaled
deployments must enforce the equivalent aggregate limits at a shared gateway.
API JSON bodies are capped
at 256 KiB, the optional bulk CDN has a separate concurrency/timeout policy,
and all responses receive the shared
security-header baseline. See
[Public Service Edge Security](service-edge-security.md#chaintracks-server-and-reusable-chaintracksservice).

`BULK_HEADERS_PATH` is now a durable state root:

- `cache/objects/<prefix>/<sha256>.headers` stores verified immutable objects;
- `cache/quarantine/` retains rejected content for later diagnosis;
- `state/download-budget.json` is flushed before each physical attempt;
- `generations/` contains complete CDN snapshots; and
- `current` atomically selects the generation served by the CDN listener.

The first upgraded boot can read the former flat files directly and serves
them as a fallback until the first new generation is complete. Roll back the
service image without deleting this root. Older releases continue to see their
flat files; the new content-addressed and generation directories are additive.

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
