---
id: infra-wallet-infra
title: "Wallet Infrastructure Services"
kind: infra
version: "2.0.4"
last_updated: "2026-06-27"
last_verified: "2026-06-27"
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

| Type | Requirement |
|------|-------------|
| Database | MySQL 8.0 via Knex + mysql2 driver (other Knex-supported DBs can be substituted) |
| External services | Arc/Taal-compatible services for transaction broadcasting and proof lookup; optional Arcade/Chaintracks support through wallet-toolbox service options |
| ts-stack packages | @bsv/wallet-toolbox, @bsv/sdk, @bsv/auth-express-middleware, @bsv/payment-express-middleware |

## HTTP endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | / | JSON-RPC 2.0 endpoint (all wallet operations) |

JSON-RPC methods: walletUtxoStorage_getHeight, walletUtxoStorage_listOutputs, walletUtxoStorage_insertOutput, walletUtxoStorage_updateOutput, walletUtxoStorage_listBaskets, walletUtxoStorage_createBasket, walletUtxoStorage_getBasket, walletUtxoStorage_listLabels, walletUtxoStorage_upsertLabel, walletUtxoStorage_dropLabels, walletUtxoStorage_listCertificates, walletUtxoStorage_insertCertificate (see @bsv/wallet-toolbox docs for full list).

## WebSocket endpoints

None; HTTP JSON-RPC only.

## Configuration (env vars)

| Variable | Required | Description |
|----------|----------|-------------|
| NODE_ENV | No | `development` or `production` |
| HTTP_PORT | No | Express server port (default: 8081, use 8081 if nginx enabled on 8080) |
| ENABLE_NGINX | No | Set to `'true'` to start nginx reverse proxy on port 8080 (default: false) |
| BSV_NETWORK | No | Target blockchain network (`main`, `test`, `ttn`, or `mock`) |
| SERVER_PRIVATE_KEY | Yes | 256-bit hex private key for server identity |
| KNEX_DB_CONNECTION | Yes | Knex database connection JSON string (e.g., `{"port":3306,"host":"mysql","user":"root","password":"rootPass","database":"wallet_storage"}`) |
| COMMISSION_FEE | No | Optional commission fee in satoshis per request (default: 0) |
| COMMISSION_PUBLIC_KEY | No | Public key to receive commission payments (if COMMISSION_FEE > 0) |
| FEE_MODEL | No | Fee calculation model as JSON (default: `{"model":"sat/kb","value":1}`) |
| TAAL_API_KEY | No | API key used by the default Arc/Taal service configuration (optional) |

The reference `infra/wallet-infra` entrypoint currently wires only the default
wallet-toolbox `Services.createDefaultOptions(chain)` path, plus `TAAL_API_KEY`
when supplied. The wallet-toolbox package itself also supports Arcade-first /
Arc-fallback service options, callback tokens, and Chaintracks event integration,
but those extra env vars are not yet exposed by this reference infra wrapper.

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
# Multi-stage Docker build: Node 22 alpine → production
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

Dockerfile uses multi-stage build (Node 22 builder → production). Optional nginx.conf reverse proxy (if ENABLE_NGINX=true) on 8080 proxying to app on 8081.

## Migrations

Auto-run on startup via Knex. Creates tables: outputs, baskets, labels, certificates, metadata with indexes on identity_key, output_hash, blockchain_height for query performance.

## Wallet monitor behavior

The process starts both the JSON-RPC storage server and a wallet-toolbox
`Monitor`:

1. `Monitor.createDefaultWalletMonitorOptions(chain, storage, services)` builds
   the monitor options for real networks.
2. `monitor.addDefaultTasks()` installs the default task set.
3. `monitor.startTasks()` runs the background task loop after the storage server
   starts.

The default task set handles:

- sending queued transactions;
- checking for delayed Merkle proofs;
- failing abandoned requests;
- reviewing proven transactions and double-spend state;
- purging completed, spent, and failed records after the configured age windows.

For `mock`, the reference server uses `MockServices` with shorter task timing so
local integration tests complete quickly.

## Health checks

There is no dedicated HTTP health endpoint in this reference wrapper. Monitor:

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
- Commission fees: COMMISSION_FEE enforcement requires COMMISSION_PUBLIC_KEY; mismatched config silently skips fee collection
- Provider concentration: with only `TAAL_API_KEY` wired by the reference wrapper,
  production deployments can become too dependent on one provider. Prefer
  exposing Arcade and Chaintracks options in infra before relying on this wrapper
  for resilient mainnet/TeraTestnet operations.
- Monitor liveness: the storage server and monitor run in the same process. A
  crash in monitor startup fails the process, which is good for visibility but
  requires process supervision and alerting.

## Source

- [GitHub](https://github.com/bsv-blockchain/wallet-infra)
- [npm package](https://npmjs.com/package/@bsv/wallet-toolbox)
