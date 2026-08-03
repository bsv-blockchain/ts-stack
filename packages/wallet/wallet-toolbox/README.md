# BSV Wallet Toolbox

[![Build Status](https://img.shields.io/github/actions/workflow/status/bsv-blockchain/ts-stack/ci.yml?branch=main&label=build)](https://github.com/bsv-blockchain/ts-stack/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@bsv/wallet-toolbox)](https://www.npmjs.com/package/@bsv/wallet-toolbox)
[![npm downloads](https://img.shields.io/npm/dm/@bsv/wallet-toolbox)](https://www.npmjs.com/package/@bsv/wallet-toolbox)

A [BRC-100](https://github.com/bitcoin-sv/BRCs/blob/master/wallet/0100.md) conforming wallet implementation for the BSV blockchain, built on the [BSV SDK](https://bsv-blockchain.github.io/ts-stack/packages/sdk/). Provides persistent storage, protocol-based key derivation, transaction monitoring, chain tracking, and signing — everything needed to build wallet-powered applications on BSV.

## Overview

The Wallet Toolbox is the reference implementation of the BRC-100 wallet interface. It connects the BSV SDK's cryptographic primitives to real storage backends, network services, and signing flows so that application developers don't have to wire these layers together themselves.

BSV Desktop and BSV Browser are the BSV Association reference wallet applications built around this interface. Vendor distributions, including Babbage's Metanet Desktop / Metanet Explorer and Hudos Browser, can implement the same BRC-100 interface against their own product packaging and service defaults.

### What's Inside

| Module             | Description                                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Wallet**         | Full BRC-100 wallet — action creation, signing, certificate management, identity discovery, output tracking                                      |
| **Storage**        | Pluggable persistence with three backends: **SQLite/MySQL** (via Knex), **IndexedDB** (browser/mobile), and **remote** (client/server over HTTP) |
| **Services**       | Network layer — ARC transaction broadcasting, chain tracking (Chaintracks), merkle proof verification, UTXO lookups via WhatsOnChain             |
| **Monitor**        | Background daemon that watches pending transactions, rebroadcasts failures, handles chain reorganizations, and manages proof acquisition         |
| **Signer**         | `WalletSigner` bridges any BRC-100 wallet to the SDK's `Transaction` signing interface                                                           |
| **Key Management** | `PrivilegedKeyManager` for secure key storage with Shamir secret sharing and obfuscation; protocol-based key derivation per BRC-42/43            |
| **Permissions**    | `WalletPermissionsManager` for fine-grained per-app, per-protocol permission control with grouped approval flows                                 |
| **MockChain**      | In-memory blockchain for testing — mock mining, UTXO tracking, and merkle proof generation without a network                                     |
| **Entropy**        | `EntropyCollector` gathers mouse/touch entropy for high-quality randomness in browser environments                                               |

### Packages

The toolbox publishes three npm packages from this repo:

- **[`@bsv/wallet-toolbox`](https://www.npmjs.com/package/@bsv/wallet-toolbox)** — Full package with all storage backends (SQLite, MySQL, IndexedDB, remote)
- **[`@bsv/wallet-toolbox-client`](https://www.npmjs.com/package/@bsv/wallet-toolbox-client)** — Browser build; excludes Node-only backends (Knex/SQLite/MySQL)
- **[`@bsv/wallet-toolbox-mobile`](https://www.npmjs.com/package/@bsv/wallet-toolbox-mobile)** — Mobile build; IndexedDB and remote storage only

## Getting Started

### Installation

```bash
# Full (Node.js servers, CLIs)
npm install @bsv/wallet-toolbox

# Browser apps
npm install @bsv/wallet-toolbox-client

# React Native / mobile
npm install @bsv/wallet-toolbox-mobile
```

### Quick Example

```typescript
import { SetupWallet } from '@bsv/wallet-toolbox'

// Create a wallet with SQLite storage and default mainnet services
const wallet = await SetupWallet({
  env: 'main',
  endpointUrl: 'https://your-storage-server.example.com'
})

// Create a transaction
const result = await wallet.createAction({
  description: 'Send payment',
  outputs: [
    {
      lockingScript: '76a914...88ac',
      satoshis: 1000,
      outputDescription: 'payment'
    }
  ]
})
```

## Documentation

[Full API documentation](https://bsv-blockchain.github.io/wallet-toolbox) is available on GitHub Pages.

See [Managed change, sweeping, and recovery](./docs/managed-change-policy.md)
for the default-basket invariant, automatic funding policy, and supported
`internalizeAction` repair paths.

See [In-memory action batch planning](./docs/action-batch-planning.md) for
capability-negotiated `noSend` planning, compact manifests, compressed binary
pack transport, atomic commit, compatibility behavior, and retained benchmarks.

### `createAction` performance telemetry

With the optional SDK telemetry sink enabled, legacy `createAction` reports
bounded-cardinality spans for input validation, record/output persistence,
funding candidate selection, fee-aware planning, atomic input claiming, input
assembly, proof fetch, BEEF merge, and final trim/serialization.
Only counts, byte sizes, fee totals, retry counts, and durations are reported;
transaction IDs, scripts, payloads, keys, and identities are not attributes.

The planner uses the same exact / least-over / largest-under selection policy
as the historical allocator, but proves economic sufficiency before writing a
transaction and claims every selected input in one database transaction. Knex
storage automatically adds a composite funding-selection index on migration;
IndexedDB schema version 3 adds corresponding user/basket and outpoint indexes
and resolves transaction-status eligibility in one indexed pass.

The retained fragmented-funding benchmark is runnable with:

```bash
pnpm bench:create-action-funding
pnpm bench:create-action-beef
```

Against unmodified commit `c212b5ee7`, a representative 102-input SQLite plan
fell from 622 queries, 102 database transactions, and 107.3 ms to 17 queries,
one transaction, and 8.8 ms. Query and transaction counts remain flat when the
selected input count grows; networked database deployments should benefit most.

The proof-bearing benchmark also exercises the authenticated remote wallet,
real BRC-103 storage RPC, BRC-29 signing, packed WASM digest verification, and
24-level proofs grouped by block. On the PXC staging topology, 20 independent
153-input samples measured 376.0 ms p50 and 461.6 ms p95; the corresponding
direct storage cohort measured 99.3 ms p50 and 137.4 ms p95. A normal one-input
authenticated cohort measured 78.6 ms p50 and 105.6 ms p95. All 3,080 signature
verdicts passed. A selective production-shaped database copy with 110 fragmented
inputs measured 75.5 ms p50 and 155.4 ms p95 for direct storage. The benchmark
captures client, server HTTP, authentication, RPC, storage, signing,
verification, and serialization spans and retains gates of 100 ms p50 / 150 ms
p95 for the normal cohort and 500 ms p95 for the 153-input cohort. These are
regression gates, not universal hardware guarantees.

Trace context remains local to the telemetry carrier and sink. Wallet Toolbox
does not add telemetry headers to AuthFetch, so BRC-103/104, Auth Express
Middleware, AuthSocket, JSON-RPC, and mixed-version remote storage behavior are
unchanged.

The codebase has detailed JSDoc annotations throughout — these will surface inline in editors like VS Code.

### Horizontal Storage scaling

`StorageServer` uses an in-process BRC-103 session manager by default. Before
running multiple processes or replicas behind a non-sticky load balancer, use
the shared Knex implementation against the same migrated wallet database:

```typescript
import { KnexSessionManager, StorageKnex, StorageServer } from '@bsv/wallet-toolbox'

const storage = new StorageKnex(storageOptions)
await storage.migrate(storageName, storageIdentityKey)
await storage.makeAvailable()

const sessionManager = new KnexSessionManager(storage.knex, {
  ttlMs: 24 * 60 * 60 * 1000,
  // Optional. Set to 0 when every authenticated use must update the row.
  touchIntervalMs: 60 * 1000
})

const server = new StorageServer(storage, {
  port: 3000,
  wallet,
  monetize: false,
  sessionManager,
  // Optional: exact trusted proxy chain. Omit for direct-socket IPs.
  trustProxy: 1,
  // Per-IP before auth (default 300/minute).
  preAuthRateLimit: { limit: 300, windowMs: 60_000 },
  // Per-identity before payment/RPC work (default 1,000/minute).
  rateLimit: { limit: 1_000, windowMs: 60_000 },
  // Public CORS is the default. Supply exact origins to opt into a whitelist.
  allowedOrigins: process.env.WALLET_ALLOWED_ORIGINS?.split(','),
  // Optional CSP/security-header overrides for an embedding deployment.
  securityHeaders: {
    contentSecurityPolicy: "default-src 'none'"
  },
  logRpcRequests: false
})
server.start()
```

Shared Knex sessions immediately persist authentication, nonce, identity, and
certificate-state transitions. For an already-authenticated row, the default
manager coalesces only timestamp-only usage touches for up to one minute. This
avoids a synchronous replicated write on every RPC while keeping durable expiry
within a bounded minute of the most recent use. Use `touchIntervalMs: 0` to
retain exact per-request timestamp persistence.

Both stages return HTTP 429 with `ERR_RATE_LIMITED`. For multi-process or
multi-replica deployments, configure a shared `express-rate-limit` store in
both options so limits are aggregate rather than per process. Never use a
permissive trust-all proxy setting; use a known hop count, subnet, or trust
predicate.

The storage service is intentionally reachable by browser apps on previously
unknown domains. With no origin configuration it uses public wildcard CORS
without cookie credentials. Passing `allowedOrigins`, setting
`WALLET_STORAGE_CORS_MODE=allowlist`, or setting the mode to `disabled`
provides opt-in restriction. BRC-103 authentication and optional payment
policy are unchanged by CORS mode.

Every replica must share the same database and session TTL. Run
`sessionManager.pruneExpiredSessions()` from one scheduled maintenance worker;
reads exclude expired rows even before they are physically pruned. Once every
replica uses the shared manager, authenticated requests no longer require
client-IP or cookie affinity.

Run `StorageKnex.migrate(...)` before constructing the manager during an
upgrade. `makeAvailable()` validates and loads an already-migrated database; it
does not apply schema changes.

## Development

```bash
git clone https://github.com/bsv-blockchain/ts-stack.git
cd ts-stack
pnpm install
pnpm --filter @bsv/wallet-toolbox format:check
pnpm --filter @bsv/wallet-toolbox lint
pnpm --filter @bsv/wallet-toolbox typecheck
pnpm --filter @bsv/wallet-toolbox test
pnpm --filter @bsv/wallet-toolbox test:coverage
pnpm --filter @bsv/wallet-toolbox pack:check
pnpm --filter @bsv/wallet-toolbox-client test:browser
pnpm --filter @bsv/wallet-toolbox-mobile test:mobile
```

Tests use Jest. The default and coverage suites are deterministic and must not
depend on live third-party services. Files named `*.man.test.ts` are explicit
manual/integration tests excluded from CI because they require credentials,
network access, or long runtimes. Files named `*.live.test.ts` are public-network
checks, also excluded from deterministic PR coverage. Run exactly one governed
suite with `test:manual -- <path>` or `test:live -- <path>` after reviewing
`governance/test-quality/policy.json`; never batch-run operator suites. CI
merges four Wallet Toolbox coverage shards
for reporting; the complete local `test:coverage` run currently measures
69.12% statements, 59.09% branches, 72.83% functions, and 71.06% lines.

Operational repair, migration, export, and long-running service procedures are
not tests. They live under [`operator/`](./operator/README.md), produce an exact
dry-run plan by default, and require explicit confirmation before they write
state or artifacts. The exact manual-suite disposition inventory in
`governance/test-quality/wallet-toolbox-manual-suites.json` prevents new
operator procedures, fixture generators, diagnostics, or examples from being
silently added as Jest suites.

Reusable source recipes live under [`examples/`](./examples/README.md). Manual
integration suites may validate an example against an explicitly configured
environment, but the example implementation itself does not live inside a test
body.

`pack:check` installs the exact CommonJS tarball and verifies its public API.
The browser and mobile commands build platform-specific packages and reject
Node-only dependency leakage. Publishing and version changes are owned by the
repository release workflow.

## Contributing

We welcome bug reports, feature requests, and pull requests.

1. Fork and clone the repository
2. `pnpm install` at the `ts-stack` repository root
3. Create a feature branch
4. Make your changes and run the relevant package checks above
5. Open a pull request

See the
[repository contribution guidelines](https://github.com/bsv-blockchain/ts-stack/blob/main/CONTRIBUTING.md)
for the full stack-wide policy.

## Contributors

|     | Name                  | GitHub                                                 | Role                       |
| --- | --------------------- | ------------------------------------------------------ | -------------------------- |
|     | Tone Engel            | [@tonesnotes](https://github.com/tonesnotes)           | Lead developer, maintainer |
|     | Darren Kellenschwiler | [@sirdeggen](https://github.com/sirdeggen)             | Core contributor           |
|     | Brayden Langley       | [@BraydenLangley](https://github.com/BraydenLangley)   | Core contributor           |
|     | Ty Everett            | [@ty-everett](https://github.com/ty-everett)           | Core contributor, reviewer |
|     | Jackie Lu             | [@jackielu3](https://github.com/jackielu3)             | Contributor                |
|     | David Case            | [@shruggr](https://github.com/shruggr)                 | Contributor                |
|     | Stephen Thomson       | [@Stephen-Thomson](https://github.com/Stephen-Thomson) | Contributor                |
|     | Chance Barimbao       | [@ChanceBarimbao](https://github.com/ChanceBarimbao)   | Contributor                |

## License

Released under the [Open BSV License](./LICENSE.txt).
