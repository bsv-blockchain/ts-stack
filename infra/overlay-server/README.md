# Overlay Express Examples

[![BSV License](https://img.shields.io/badge/license-Open%20BSV-blue)](#license)

A set of ready-to-run configuration examples for stand-alone Overlay nodes built with [`@bsv/overlay-express`](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/overlays/overlay-express). Use these examples to spin-up your own overlay infrastructure for distributed applications on Bitcoin SV.

Resource profiles and the custom-lookup safety contract are documented in
[Service Resource Profiles](../../docs/reference/service-resource-profiles.md).

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Available NPM Scripts](#available-npm-scripts)
- [Docker Compose](#docker-compose)
- [Project Structure](#project-structure)
- [Contributing](#contributing)
- [License](#license)

## Prerequisites

1. **Node.js 24** (the container and governed contributor runtime use Node 24)
2. **npm >= 11** (comes with Node 24).
3. **Docker & Docker Compose** – only required if you want to run the full stack with MySQL and MongoDB from containers.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Create your .env file and set the variables listed below
cp .env.example .env || true   # if you keep a sample file in the repo

# 3. Start an overlay node in dev-watch mode
npm run dev
```

The service will start on `http://localhost:8080` by default. For production builds run `npm run build && npm start` or use Docker as described below.

## Configuration

All critical configuration is supplied through environment variables. Create a `.env` file in the project root (or use secrets in your orchestration platform) and define:

| Variable                       | Example                                  | Description                                                                                                                         |
| ------------------------------ | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_NAME`                    | `my-overlay`                             | One-word, lowercase overlay service node identifier.                                                                                |
| `SERVER_PRIVATE_KEY`           | required                                 | Dedicated 32-byte hex root private key for the server wallet. Generate and inject it outside source control.                        |
| `HOSTING_URL`                  | `https://my.overlay.network`             | Public URL where your node is reachable.                                                                                            |
| `ADMIN_TOKEN`                  | `at-least-32-random-characters`          | Random token of at least 32 characters required to access the admin API.                                                            |
| `WALLET_STORAGE_URL`           | `https://store-us-1.bsvb.tech`           | Wallet storage endpoint where advertisement tokens will be kept, and from where funds will be drawn.                                |
| `NETWORK`                      | `main`, `test`, or `ttn`                 | BSV Blockchain network your node operates on. TTN uses the public TTN Arcade endpoint by default and Arcade-backed ChainTracks.     |
| `ARC_API_KEY`                  | —                                        | Your ARC key for transaction broadcasting.                                                                                          |
| `ARC_CALLBACK_TOKEN`           | `independent-32-character-random-secret` | Separate random secret of at least 32 characters required to authenticate `/arc-ingest` callbacks.                                  |
| `MONGO_URL`                    | `mongodb://root:example@localhost:27017` | MongoDB connection string.                                                                                                          |
| `KNEX_URL`                     | `mysql://user:pass@localhost:3306/appdb` | MySQL connection string used by Knex.                                                                                               |
| `GASP_ENABLED`                 | `true / false`                           | Enable Graph Aware Sync Protocol to sync with other overlays on the same topics.                                                    |
| `DISCOVERY_ROOT`               | `false`                                  | Explicitly register this public node as a SHIP/SLAP discovery root and bootstrap its advertisement lookups at its own HTTPS origin. |
| `MANDALA_ENABLED`              | `false`                                  | Explicitly enable the regulated Mandala topic; disabled by default.                                                                 |
| `MANDALA_VERIFIER_PRIVATE_KEY` | required when enabled                    | Dedicated 32-byte hex linkage-verifier root, distinct from the node and Mandala admin roots.                                        |
| `MANDALA_ADMIN_PRIVATE_KEY`    | required when enabled                    | Dedicated 32-byte hex Mandala administrative root, distinct from the node and verifier roots.                                       |
| `MANDALA_STATIC_DENYLIST_JSON` | `[]`                                     | Explicit JSON array of canonical compressed identity keys for reference/local screening.                                            |

A complete example can be found in `docker-compose.yml`.

## Available NPM Scripts

| Script          | Purpose                                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------- |
| `npm run dev`   | Starts the TypeScript source directly using [tsx](https://npm.im/tsx) with hot-reload – perfect for development. |
| `npm run build` | Compiles TypeScript into the `dist/` folder.                                                                     |
| `npm start`     | Runs the compiled JavaScript (`dist/index.js`).                                                                  |

## Docker Compose

Spin-up the entire stack (Overlay node + MongoDB + MySQL) using:

```bash
docker compose up --build
```

This invokes the multi-stage `Dockerfile`, builds the TypeScript sources, and starts the server on port `8080`.

When the container is up you will see logs similar to:

```
OverlayExpress ▸ Server listening on port 8080
```

Press `Ctrl + C` to stop or add the `-d` flag to run in detached mode.

## Project Structure

```
.
├── src/               # TypeScript sources (topic managers, lookup services, bootstrapping)
├── deploy/            # Deployment helpers & scripts
├── docker-compose.yml # Container-based local environment
└── Dockerfile         # Production container image
```

## Contributing

Pull requests and issues are welcome! Please open an issue to discuss any major changes.

## License

[Open BSV License Version 6](./LICENSE.txt)

## Mandala state adapter compatibility

The bundled server does not register `tm_mandala` or `ls_mandala` unless
`MANDALA_ENABLED=true`. Enabling it requires independent node, linkage-verifier,
and administrative private keys plus an explicit static denylist snapshot. A
missing, malformed, duplicated, or oversized screening list fails startup.
The static provider is a reference/local adapter only: a production regulated
token service must replace it in application code with an authoritative,
continuously maintained `ScreeningProvider`, custody the verifier and admin
roots independently in HSM/KMS-backed systems, and define rotation and recovery.

The Mandala manager and lookup share one lazily initialized storage manager.
The admission adapter verifies admin outpoints against that store's per-asset
history, including the asset, transaction ID and output index. This wiring uses
the existing history API so it can compile with the currently locked package
and consume Overlay Topics 1.8.0's stricter admission contract on upgrade.
Before a deployed upgrade, follow the [Mandala migration guide](../../packages/overlays/topics/README.md#mandala-admission-and-the-180-upgrade)
and audit historical admin and owner records. Source publication does not
upgrade a running overlay or its locked dependencies automatically.

## UHRP discovery compatibility

Image 2.1.43 consumes Overlay 2.6.2, discovery services 2.2.6,
Overlay Express 2.7.3 and Overlay Topics 1.9.1. These patches restore bounded
SDK discovery across deterministic pages, hydrate unconfirmed SQL output heights
as absent metadata, and accept the SDK's 200-row UHRP page. Existing signatures,
query selectors, transaction bytes, resource ceilings and database schemas are
unchanged. No data migration is required. Build and publish through the protected
image workflow, validate submit/discovery/download in staging, and promote only
the same verified digest after acceptance. Source reconciliation does not deploy
a running service.

## Public discovery roots

Image candidate 2.1.44 adds `DISCOVERY_ROOT=true` for operator-designated public
SHIP/SLAP roots. Ordinary nodes retain suppressed advertisements for the default
discovery topics and services. An enabled root advertises `tm_ship`, `tm_slap`,
`ls_ship` and `ls_slap` alongside its configured application services. Its wallet
advertiser reads existing SHIP/SLAP advertisements directly from `HOSTING_URL`,
avoiding a dependency on discovering `ls_ship` before it can register that service.
Client SDKs continue using their normal network presets without host overrides.

Root mode requires a credential-free HTTPS origin with no path, query or
fragment. No database or wire migration is required, and existing advertisement
signatures, admission and propagation checks remain enforced. Validate default
SDK discovery and a real advertisement broadcast after staging the verified
image. To retire root mode, unset the flag and run normal advertisement sync; it
revokes the default discovery advertisements while preserving application ones.
A process restart alone should not be treated as proof of their withdrawal.
