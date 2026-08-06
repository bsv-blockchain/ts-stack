---
id: infra-wallet-infra
title: 'Wallet Infrastructure Services'
kind: infra
version: '2.0.25'
last_updated: '2026-08-06'
last_verified: '2026-08-06'
review_cadence_days: 30
status: stable
tags: [wallet, utxo-storage, json-rpc, brc-100, storage-server]
---

# Wallet Infrastructure Services

> A reference implementation of BSV wallet infrastructure for secure UTXO storage and management. Provides HTTP JSON-RPC endpoints for wallet clients to store/retrieve transaction outputs, track spent/unspent states, manage baskets and labels, and store certificate data.

## What it does

The Wallet Infrastructure Server implements JSON-RPC 2.0 endpoints backed by MySQL via Knex, extending `@bsv/wallet-toolbox` base classes. Clients POST JSON-RPC method calls (walletUtxoStorage_getHeight, walletUtxoStorage_listOutputs, walletUtxoStorage_insertOutput, walletUtxoStorage_updateOutput, walletUtxoStorage_listBaskets, walletUtxoStorage_createBasket, etc.) to a single / endpoint. The server enforces mutual authentication via BRC-103 auth middleware, optionally enforces micropayment pricing via `@bsv/payment-express-middleware`, and manages UTXO state in MySQL with indexes on identity_key, output_hash, and blockchain_height.

Clients connect with identity-based auth headers, manage UTXOs, baskets, labels, and certificates via standardized JSON-RPC interface compatible with @bsv/wallet-toolbox WalletClient.

## When to deploy this

- Hosting wallet UTXO storage service for multiple wallet clients
- You need BRC-100-compliant JSON-RPC wallet interface
- Supporting basket/label/certificate metadata alongside UTXOs
- Enforcing optional micropayment pricing per API call
- Production wallet infrastructure with MySQL persistence

## Dependencies

| Type              | Requirement                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Database          | MySQL 8.0 via Knex + mysql2 driver (other Knex-supported DBs can be substituted)                                                                       |
| External services | Arc/Taal-compatible services for transaction broadcasting and proof lookup; optional Arcade/Chaintracks support through wallet-toolbox service options |
| ts-stack packages | @bsv/wallet-toolbox, @bsv/sdk, @bsv/auth-express-middleware, @bsv/payment-express-middleware                                                           |

## HTTP endpoints

| Method | Path                                | Purpose                                       |
| ------ | ----------------------------------- | --------------------------------------------- |
| POST   | /                                   | JSON-RPC 2.0 endpoint (all wallet operations) |
| PUT    | /action-batch/:batchId/blob/:digest | Authenticated bounded binary blob upload      |
| GET    | /, /robots.txt                      | Public service metadata                       |
| GET    | /healthz                            | Public process/storage health                 |

JSON-RPC methods: walletUtxoStorage_getHeight, walletUtxoStorage_listOutputs, walletUtxoStorage_insertOutput, walletUtxoStorage_updateOutput, walletUtxoStorage_listBaskets, walletUtxoStorage_createBasket, walletUtxoStorage_getBasket, walletUtxoStorage_listLabels, walletUtxoStorage_upsertLabel, walletUtxoStorage_dropLabels, walletUtxoStorage_listCertificates, walletUtxoStorage_insertCertificate (see @bsv/wallet-toolbox docs for full list).

## WebSocket endpoints

None; HTTP JSON-RPC only.

## Configuration (env vars)

| Variable                                 | Required  | Description                                                                                                                                                 |
| ---------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NODE_ENV                                 | No        | `development` or `production`                                                                                                                               |
| HTTP_PORT                                | No        | Express server port (default: 8081, use 8081 if nginx enabled on 8080)                                                                                      |
| ENABLE_NGINX                             | No        | Set to `'true'` to start nginx reverse proxy on port 8080 (default: false)                                                                                  |
| BSV_NETWORK                              | No        | Target blockchain network (`main`, `test`, `ttn`, `tstn`, or `mock`); historical monitor alias `CHAIN` is accepted                                           |
| SERVER_PRIVATE_KEY                       | Yes       | 256-bit hex private key for server identity                                                                                                                 |
| KNEX_DB_CONNECTION                       | Yes       | Knex database connection JSON string; historical monitor aliases `MAIN_KNEX_DB_CONNECTION` and `TEST_KNEX_DB_CONNECTION` are selected by network             |
| COMMISSION_FEE                           | No        | Optional commission fee in satoshis per request (default: 0)                                                                                                |
| COMMISSION_PUBLIC_KEY                    | No        | Public key to receive commission payments (if COMMISSION_FEE > 0)                                                                                           |
| FEE_MODEL                                | No        | Fee calculation model as JSON (default: `{"model":"sat/kb","value":1}`)                                                                                     |
| TAAL_API_KEY                             | No        | API key used by the default Arc/Taal service configuration (optional)                                                                                       |
| TSTN_ARCADE_URL                          | tstn only | Private Arcade (broadcast + merkle proofs) endpoint for the `tstn` network. Not public; supplied per-deployment. Also used as the default ChainTracks host. |
| TSTN_CHAINTRACKS_URL                     | No        | Private ChainTracks endpoint for `tstn`. Defaults to `${TSTN_ARCADE_URL}/chaintracks/v1` when omitted.                                                      |
| WALLET_STORAGE_CORS_MODE                 | No        | `public` (default), `allowlist`, or `disabled`                                                                                                              |
| WALLET_STORAGE_CORS_ALLOWED_ORIGINS      | No        | Exact comma-separated origins in allowlist mode                                                                                                             |
| WALLET_STORAGE_JSON_MAX_BODY_BYTES       | No        | JSON-RPC body ceiling (default 31457280)                                                                                                                    |
| WALLET_STORAGE_BINARY_MAX_BODY_BYTES     | No        | Blob body ceiling (default 8388608)                                                                                                                         |
| WALLET_STORAGE_RPC_DEFAULT_LIST_LIMIT    | No        | Row limit inserted for list/find RPCs that omit one (standard default `1000`; `-1`/`unlimited` is an explicit operator opt-out)                            |
| WALLET_STORAGE_RPC_MAX_LIST_LIMIT        | No        | Largest explicit list/find page (standard default `1000`; legacy 10,000-row clients require a measured `10000` compatibility override)                    |
| WALLET_STORAGE_RPC_MAX_ARRAY_ITEMS       | No        | Maximum items in any decoded RPC request array (standard default `1000000`)                                                                                |
| WALLET_STORAGE_RPC_MAX_RESPONSE_BYTES    | No        | Serialized JSON-RPC response ceiling (standard default `8388608`)                                                                                          |
| WALLET_STORAGE_TRUST_PROXY_HOPS          | No        | Exact trusted reverse-proxy hop count, 0–10 (default 0/direct exposure)                                                                                     |
| WALLET_STORAGE_MONITOR_START_TASKS       | No        | Enable monitor work for `all`/`monitor` roles (default true; historical alias supported)                                                                    |
| WALLET_STORAGE_MONITOR_STARTUP_TASK_MODE | No        | `default`, `multiuser`, `alltoother`, or `none` (default `default`; historical alias supported)                                                             |
| WALLET_STORAGE_MONITOR_ADMIN_ENABLED     | No        | Enable the private authenticated monitor operator listener on an `all` or `monitor` singleton (default false)                                               |
| WALLET_STORAGE_MONITOR_ADMIN_HOST        | No        | Operator listener bind host (default `127.0.0.1`)                                                                                                           |
| WALLET_STORAGE_MONITOR_ADMIN_PORT        | No        | Operator listener port (default `8082`; must not collide with the storage/nginx listener)                                                                   |
| WALLET_STORAGE_MONITOR_ADMIN_PRIVATE_KEY | No        | Stable operator-service identity key; secret; defaults to `SERVER_PRIVATE_KEY`                                                                              |
| WALLET_STORAGE_ADMIN_IDENTITY_KEYS       | Admin     | Comma-separated compressed public keys allowed to use storage and monitor admin APIs                                                                        |

See [Public Service Edge Security](service-edge-security.md#wallet-storageserver-and-adminserver)
for the authentication, rate, timeout, logging, CORS/CSP, admin, and nginx
contracts.

> `tstn` (Teranode Scaling Test Net) runs only Arcade and ChainTracks — it has no
> WhatsOnChain / block-explorer service. Its endpoints are private and are read from the
> environment at runtime rather than hardcoded, so `TSTN_ARCADE_URL` (and optionally
> `TSTN_CHAINTRACKS_URL`) must be set whenever `BSV_NETWORK=tstn`.

The reference entrypoint exposes TAAL, WhatsOnChain, Bitails, Arcade,
GorillaPool ARC, exchange-rate, callback-token, monitor-profile, and database
pool settings through the documented `WALLET_STORAGE_*` variables. Historical
provider and monitor variable names remain accepted where documented so an
operator can adopt the official image without rebuilding it.

Wallets should keep explicit list pages within
`WALLET_STORAGE_RPC_MAX_LIST_LIMIT`. Balance displays should use
wallet-toolbox's database-side balance special operation rather than loading
and summing every output in the client. A temporary 10,000-row maximum can
support historical BRC-100 clients, but only after production-shaped memory
testing and with the response-byte and concurrency ceilings still enabled.

## Run locally

```bash
# Install dependencies
npm install

# Development with ts-node
npm run dev

# Requires MySQL running
docker compose up -d mysql

# Build TypeScript
npm run build

# Run production build
npm start
```

## Deploy to production

```bash
# Multi-stage Docker build: pinned Node 24 alpine → production
docker build -t wallet-infra:latest .

# Run with MySQL backend
docker run -d \
  -e NODE_ENV=production \
  -e HTTP_PORT=8081 \
  -e BSV_NETWORK=main \
  -e SERVER_PRIVATE_KEY=<256-bit-hex> \
  -e KNEX_DB_CONNECTION='{"port":3306,"host":"mysql","user":"root","password":"rootPass","database":"wallet_storage"}' \
  -e COMMISSION_FEE=1000 \
  -e COMMISSION_PUBLIC_KEY=<pubkey> \
  -p 8081:8081 \
  wallet-infra:latest

# With optional nginx reverse proxy on port 8080
docker run -d \
  -e ENABLE_NGINX=true \
  ... (other env vars)
  -p 8080:8080 \
  -p 8081:8081 \
  wallet-infra:latest

# Or via docker-compose (includes MySQL)
docker compose up -d
```

Dockerfile uses a digest-pinned Node 24 multi-stage build. Optional nginx.conf reverse proxy (if ENABLE_NGINX=true) on 8080 proxying to app on 8081.

## Migrations

Auto-run on startup via Knex. Creates tables: outputs, baskets, labels, certificates, metadata with indexes on identity_key, output_hash, blockchain_height for query performance.

## Wallet monitor behavior

The process starts both the JSON-RPC storage server and a wallet-toolbox
`Monitor`:

1. `Monitor.createDefaultWalletMonitorOptions(chain, storage, services, ...,
startupTaskMode)` builds the selected task profile for real networks.
2. Arcade callback-token and EventSource support are attached when both are
   configured.
3. `monitor.startTasks()` runs the background task loop when the role and
   `WALLET_STORAGE_MONITOR_START_TASKS` permit it.

The default task set handles:

- sending queued transactions;
- checking for delayed Merkle proofs;
- failing abandoned requests;
- reviewing proven transactions and double-spend state;
- purging completed, spent, and failed records after the configured age windows.

For `mock`, the reference server uses `MockServices` with shorter task timing so
local integration tests complete quickly.

## Health checks

The storage listener exposes `/healthz`. When the optional monitor operator
listener is enabled, it exposes its own `/healthz` plus the static `/admin`
bootstrap page; authenticated and allowlisted BRC-100 clients can use
`/admin/api`. Monitor:

- MySQL connectivity and query latency.
- JSON-RPC endpoint responds to method calls, such as
  `walletUtxoStorage_getHeight`.
- Monitor startup emits `monitor.start` with `outcome=ok`.
- Repeated monitor task failures, especially send/proof/double-spend review
  failures.
- Database indexes are present and functional.

If this component is deployed behind nginx, also check the nginx listener and the
upstream app port (`HTTP_PORT`, default `8081`).

## Spec conformance

- **BRC-100** – Full JSON-RPC wallet interface for UTXO storage and management
- **BRC-103** – Mutual authentication on all API calls
- **BRC-105** – Optional envelope support for multi-sig authorization
- **JSON-RPC 2.0** – Standard JSON-RPC protocol on POST /

## Integration with ts-stack

- BSV wallet clients use this via @bsv/wallet-toolbox WalletClient
- Storage implementation extends @bsv/wallet-toolbox base classes
- Integrates with Arc/Taal-compatible providers for fee estimation, transaction
  submission, and proof acquisition. Newer wallet-toolbox service options can
  configure Arcade as the primary broadcaster with Arc fallback, but the
  reference infra wrapper needs explicit env wiring before operators can enable
  that without code changes.
- Optional payment middleware charges per-call or per-route via BRC-100
- Advertises wallet storage service capability to overlay network

## Common pitfalls

- Knex connection JSON must be valid; malformed connection string causes startup failure
- MySQL 8.0 required; earlier versions lack necessary index types
- Identity key indexing critical: high-volume wallets need composite index (identity_key, output_hash) for query performance
- Stateless design: multiple instances can share MySQL database with proper connection pooling
- BRC-103 auth enforced: all clients must provide signed auth headers; unsigned requests rejected
- Migrations auto-run: schema changes apply on startup; use Knex CLI for manual migration control if needed
- Optional nginx: ENABLE_NGINX=true adds another layer; ensure port 8080 available and firewall open
- Monitor admin: keep its dedicated listener private, use a stable secret-managed server key and explicit allowed identity keys, and run it only on the singleton monitor leader
- Commission fees: COMMISSION_FEE enforcement requires COMMISSION_PUBLIC_KEY; mismatched config silently skips fee collection
- Provider concentration: configure more than one supported provider where the
  target network offers them, and alert on individual broadcaster/proof-source
  failures.
- Monitor liveness: the storage server and monitor run in the same process. A
  crash in monitor startup fails the process, which is good for visibility but
  requires process supervision and alerting.

## Source

- [GitHub](https://github.com/bsv-blockchain/ts-stack/tree/main/infra/wallet-infra)
- [npm package](https://npmjs.com/package/@bsv/wallet-toolbox)
