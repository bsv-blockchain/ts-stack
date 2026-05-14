# CLAUDE.md — Wallet Infra (UTXO Management Server)

## Purpose
A reference implementation of BSV wallet infrastructure for secure UTXO storage and management. Provides HTTP JSON-RPC endpoints for wallet clients to store/retrieve transaction outputs, track spent/unspent states, manage baskets and labels, and store certificate data. Enforces mutual authentication and supports optional micropayment pricing. Built on `@bsv/wallet-toolbox` and fully customizable for production deployments.

## Service surface
- **JSON-RPC endpoint** – `POST /` with methods for wallet operations (BRC-100 compliant)
  - `walletUtxoStorage_getHeight` – Current blockchain height
  - `walletUtxoStorage_listOutputs` – Query UTXOs with filters
  - `walletUtxoStorage_insertOutput` – Store transaction output
  - `walletUtxoStorage_updateOutput` – Modify output metadata
  - `walletUtxoStorage_listBaskets` – Query output baskets
  - `walletUtxoStorage_createBasket` – Create named output group
  - And dozens more (see @bsv/wallet-toolbox docs)
- **Admin endpoints** (if configured)
  - Health checks, monitoring, metrics
- **WebSocket** – Optional real-time UTXO update notifications (not in base config)

## Real deployment
- **Dockerfile** – Alpine-based Node 22 image. Compiles TypeScript to `out/`, runs `node out/src/index.js` with nginx reverse proxy support
- **docker-compose.yml** – Services: Node app (on port 8081), MySQL 8.0 database with health checks
- **nginx.conf** – Optional reverse proxy (if ENABLE_NGINX=true), listening on 8080, proxying to app on 8081
- **Knex migrations** – Auto-applied on startup via `@bsv/wallet-toolbox`
  - Creates tables: outputs, baskets, labels, certificates, metadata
  - Indexes on identity_key, output_hash, blockchain_height for query performance

## Configuration
Environment variables (from `.env.example`):
- **NODE_ENV** – `development` or `production`
- **HTTP_PORT** – Express server port (default: 8081, use 8081 if nginx is enabled on 8080)
- **ENABLE_NGINX** – Set to `'true'` to start nginx reverse proxy on port 8080 (default: false)
- **BSV_NETWORK** – Target blockchain network (`main`, `test`, or `regtest`)
- **SERVER_PRIVATE_KEY** – 256-bit hex private key for server identity (required)
- **KNEX_DB_CLIENT** – Knex client: `"mysql2"` (default) or `"pg"`. Alternatively set `"client"` inside `KNEX_DB_CONNECTION`. Accepted aliases: `mysql`, `mysql2`, `pg`, `postgres`, `postgresql`.
- **KNEX_DB_CONNECTION** – Knex database connection JSON string
  - MySQL example: `{"port":3306,"host":"mysql","user":"root","password":"rootPass","database":"wallet_storage"}`
  - Postgres example: `{"port":5432,"host":"postgres","user":"wallet_admin","password":"walletPass","database":"wallet_storage"}`
- **KNEX_POOL_MAX** – Pool max connections (default: 32). Tune up with vCPU count or behind a pooler.
- **KNEX_POOL_MIN** – Pool min connections (default: 2).
- **COMMISSION_FEE** – Optional commission fee in satoshis per request (default: 0)
- **COMMISSION_PUBLIC_KEY** – Public key to receive commission payments (if COMMISSION_FEE > 0)
- **FEE_MODEL** – Fee calculation model as JSON (default: `{"model":"sat/kb","value":1}`)
- **TAAL_API_KEY** – API key for Taal blockchain data service (optional; populates `arcConfig.apiKey` + `taalApiKey`)
- **ARC_URL** – ARC endpoint base URL (e.g. `https://arcade-v2-us-1.bsvblockchain.tech`). Applies only when chain ≠ `mock`.
- **ARC_API_KEY** – API key for ARC. Overrides `TAAL_API_KEY` in `arcConfig.apiKey` if both are set.
- **ARC_CALLBACK_TOKEN** – Enables `TaskArcSSE` proof-callback subscription. Without it, log shows `[TaskArcadeSSE] no callbackToken configured — SSE disabled`.
- **LEGACY_UPGRADE** – Set to `"true"` ONLY when upgrading an existing v2 database with real legacy `transactions` rows. v3 is the default canonical schema: fresh installs (empty `transactions` table) auto-initialize into the v3 layout at boot without any flag. If the server detects legacy v2 rows but no `transactions_legacy` marker and this flag is unset, it refuses to boot — operator must back up, then either set `LEGACY_UPGRADE=true` or run `npm run cutover` standalone (with server restart afterwards because `StorageKnex._postCutoverCache` is initialised once at `makeAvailable()` and never refreshed).

## Dependencies
- **Database** – MySQL 8.0 (default, via Knex + mysql2 driver) **or** PostgreSQL 14+ (via Knex + pg driver). `pg` is declared as an `optionalDependencies` entry so MySQL-only deployments install nothing extra. Set `KNEX_DB_CLIENT=pg` to pick Postgres at deploy time. Reference compose stacks: `docker-compose.yml` (MySQL), `docker-compose.pg.yml` (Postgres).
- **@bsv packages**
  - `@bsv/wallet-toolbox` – Core UTXO storage, wallet operations, migrations
  - `@bsv/sdk` – Cryptography, key operations, transaction handling
  - `@bsv/auth-express-middleware` – BRC-103 mutual authentication
  - `@bsv/payment-express-middleware` – Optional payment verification for API calls
- **External services**
  - Blockchain data (via Taal or ARC) – Transaction broadcasting, blockchain height queries
  - Optional: Monitoring/observability (CloudWatch, Datadog, etc.)
- **Key packages** – Express, body-parser, dotenv, knex, mysql2

## Operational concerns
- **Local dev** – `npm run dev` (uses ts-node) requires MySQL running (use docker-compose up)
- **Build** – `npm run build` compiles TypeScript to `out/`
- **Production** – Docker container or direct `node out/src/index.js` with MySQL connection
- **Migrations** – Auto-run on startup; Knex manages schema versioning
- **v3 schema** – v3 is the canonical target schema. Fresh installs auto-initialize into v3 at boot (no flag). Upgrading an existing v2 DB with legacy `transactions` rows requires `LEGACY_UPGRADE=true` or a standalone `npm run cutover` + restart. Server refuses to boot on legacy-populated data without explicit authorization. See `@bsv/wallet-toolbox` docs/CUTOVER_RUNBOOK.md for details.
- **Scaling** – Stateless design; multiple instances can share same MySQL database with connection pooling
- **Database** – MySQL 8.0 (default) or PostgreSQL 14+. Both run the same Knex migrations from `@bsv/wallet-toolbox`. Engine-specific paths (FK toggle, substring SQL, raw-result shape, cutover FK rebuild) are encapsulated in `StorageKnex`. Ensure adequate indexing on identity_key, output_hash, and blockchain_height.
- **Authentication** – BRC-103 mutual auth on all JSON-RPC calls; enforces identity-based access control
- **Payment enforcement** – Optional via `@bsv/payment-express-middleware`; can charge per-call or per-route
- **Performance** – Consider database query caching, connection pooling tuning, and output batch operations for high-volume deployments
- **Nginx** – Optional reverse proxy for load balancing, SSL termination (ENABLE_NGINX=true adds nginx on port 8080)

## Spec conformance
- **BRC-100** – Full JSON-RPC wallet interface for UTXO storage and management
- **BRC-103** – Mutual authentication on all API calls
- **BRC-105** – Optional envelope support for multi-sig authorization
- **JSON-RPC 2.0** – Standard JSON-RPC protocol on POST /

## Integration points
- **BSV wallet clients** – Use this server for UTXO storage, retrieval, and blockchain queries
- **Wallet Toolbox** – Storage implementation extends `@bsv/wallet-toolbox` base classes
- **Blockchain services** – Integrates with Taal or ARC for fee estimation and transaction submission
- **Payment processors** – Optional payment middleware for micropayment collection
- **Overlay network** – Can advertise wallet storage service capability

## File map
- **src/**
  - `index.ts` – Entry point: initializes Knex, wallet-toolbox, StorageServer, starts HTTP server. Optionally calls `runSchemaCutover` when `AUTO_CUTOVER=true`.
  - `cutover.ts` – Standalone runner for `runSchemaCutover`. Invoked via `npm run cutover` for operator-controlled cutover timing on production.
  - **No app.ts** – Configuration is inline in index.ts via wallet-toolbox classes
- **out/** – Compiled TypeScript output (created by `npm run build`)
- **Dockerfile** – Alpine-based Node 22 with nginx optional support; copies `vendor-wallet-toolbox.tgz` for local wallet-toolbox builds when not consuming the published npm version
- **vendor-wallet-toolbox.tgz** – Optional local tarball produced via `npm pack` in `packages/wallet/wallet-toolbox`. When present, `package.json` dep is `file:./vendor-wallet-toolbox.tgz`. Allows iterating on wallet-toolbox without publishing to npm.
- **docker-compose.yml** – App + MySQL 8.0
- **nginx.conf** – Reverse proxy config (used if ENABLE_NGINX=true)
- **.env.example** – Template with all required/optional variables
- **tsconfig.json** – TypeScript configuration
- **package.json** – Scripts: `build`, `start`, `cutover`
- **guides/** – Deployment guides (local_development.md, gcloud_deployment.md for Cloud Run)
