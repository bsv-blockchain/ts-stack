# Wallet Infra - UTXO Management Server

This repository serves as a reference implementation for building and deploying BSV Wallet Infrastructure. It contains the configuration and code necessary to build and run a wallet storage server (also referred to as a “UTXO Management Server”). The server securely stores and manages UTXOs, providing a reliable backend for BSV wallet clients, all while never accessing user-held keys.

Built on the [wallet-toolbox](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/wallet/wallet-toolbox), this implementation empowers developers with extensive customization options for authentication, monetization, and database management to name a few.

See [Service Resource Profiles](../../docs/reference/service-resource-profiles.md)
for RPC ceilings, API/monitor role separation, official-image provider settings,
and Wallet Storage HPA prerequisites.

## Key Features

1. #### Out-of-the-Box UTXO Management
   - The server automatically handles all core wallet storage actions—storing transaction outputs (UTXOs), managing spent/unspent states, tracking labels, baskets, certificates, and more.
   - **Auto-migrations** on startup (via Knex).

2. #### Customizable Monetization
   - By default, sets a `calculateRequestPrice` returning `0`, but you can easily **charge** clients in satoshis for each API call—either flat fees or **per-route** fees.
   - Using [`@bsv/payment-express-middleware`](https://github.com/bitcoin-sv/payment-express-middleware) in combination with the `monetize` flag, you can create a system that verifies micropayments on each request.

3. #### Mutual Authentication
   - The server uses [`@bsv/auth-express-middleware`](https://github.com/bitcoin-sv/auth-express-middleware) to ensure that **both** the client and the server authenticate before a request is allowed through.
   - This ensures that only authorized wallets can read or modify UTXO data.

4. #### Flexible Database Choice
   - MySQL is used in this example (`mysql2` driver, `knex` config), however, you can integrate **any** DB driver that [Knex](https://knexjs.org/) supports—PostgreSQL, SQLite, etc.

5. #### Extensible Codebase
   - The `WalletStorageManager` class can handle multiple active or backup storage providers, letting you replicate or sync data across different backends.
   - The `StorageServer` class is an Express-based HTTP server that exposes a JSON-RPC endpoint. You can add your own routes, middlewares, or entire route controllers to further extend its functionality as needed for your [BRC-100](https://github.com/bitcoin-sv/BRCs/blob/master/wallet/0100.md) compliant wallet.

6. #### Just Defaults—Feel Free to Customize
   - The code in `index.ts` is a basic example. Everything from `SERVER_PRIVATE_KEY`, `HTTP_PORT`, `KNEX_DB_CONNECTION`, to fee/commission handling can be **tweaked** in environment variables or replaced with your own logic.

### Trusted reverse proxies

Direct deployments should leave `WALLET_STORAGE_TRUST_PROXY_HOPS` unset or set
it to `0`. Behind a known ingress, set it to the exact number of trusted proxy
hops (for example, `1` for a single Kubernetes ingress). This lets the built-in
rate limiter key unauthenticated requests by the validated client address
without trusting caller-supplied forwarding chains.

### RPC list compatibility and balances

Wallet Storage inserts a 1,000-row limit when a list/find RPC omits one and,
in the standard profile, rejects an explicit page above 1,000. Keep wallet
clients at or below the operator's `WALLET_STORAGE_RPC_MAX_LIST_LIMIT`; for an
exact account balance, use wallet-toolbox's balance special operation instead
of materializing every output.

Some historical BRC-100 clients request pages of 10,000 rows. Operators can
temporarily set `WALLET_STORAGE_RPC_MAX_LIST_LIMIT=10000` to preserve those
clients without rebuilding the official image, but the response-byte ceiling
still applies. Treat that as a measured compatibility profile: test
production-shaped rows under the real memory limit, reduce concurrency when
needed, and migrate clients to bounded pages or the balance special operation
before restoring the standard 1,000-row maximum.

### Monitor task profile and Arcade events

`WALLET_INFRA_ROLE=all` or `monitor` starts monitor work by default. Set
`WALLET_STORAGE_MONITOR_START_TASKS=false` to keep that work disabled, or
choose `default`, `multiuser`, `alltoother`, or `none` with
`WALLET_STORAGE_MONITOR_STARTUP_TASK_MODE`. The default profile preserves the
existing official-image behavior. The historical `MONITOR_START_TASKS` and
`MONITOR_STARTUP_TASK_MODE` names remain accepted for migration compatibility.

When both `WALLET_STORAGE_ARCADE_URL` (or `ARCADE_URL`) and
`WALLET_STORAGE_ARCADE_CALLBACK_TOKEN` (or `ARCADE_CALLBACK_TOKEN`) are set,
the monitor subscribes to Arcade's SSE status stream with the same callback
token used for transaction broadcasts. Keep the token in the deployment
secret manager; startup and connection logs do not print it.

### Monitor operator service

The singleton `all` or `monitor` role can optionally expose wallet-toolbox's
authenticated monitor operator UI and API. This preserves operational access
to monitor statistics, tasks, UTXO reviews, proof-request inspection, and
manual rebroadcasts without requiring a custom image.

Set `WALLET_STORAGE_MONITOR_ADMIN_ENABLED=true`, configure one or more
compressed public keys in `WALLET_STORAGE_ADMIN_IDENTITY_KEYS`, and bind a
dedicated listener with `WALLET_STORAGE_MONITOR_ADMIN_HOST` (default
`127.0.0.1`) and `WALLET_STORAGE_MONITOR_ADMIN_PORT` (default `8082`). The
listener must not share `HTTP_PORT`, or nginx port 8080 when nginx is enabled.
Keep it private to operators; BRC-100 authentication and the identity allowlist
protect `/admin/api`, but they do not make a public administrative endpoint a
good deployment boundary. The unauthenticated `/healthz` and static `/admin`
bootstrap page remain available on that listener.

`WALLET_STORAGE_MONITOR_ADMIN_PRIVATE_KEY` gives the operator service a stable
server identity and must come from a secret manager. When omitted, it uses
`SERVER_PRIVATE_KEY`. `WALLET_STORAGE_MONITOR_ADMIN_ALLOWED_ORIGINS` can apply
an optional comma-separated browser-origin allowlist. The historical
`ADMIN_PORT`, `ADMIN_HOST`, `ADMIN_ROOT_KEY_HEX`, `ADMIN_IDENTITY_KEYS`, and
`ADMIN_ALLOWED_ORIGINS` names remain accepted so existing monitor deployments
can move to this image without rewriting their secret material. A historical
`ADMIN_PORT` also enables the service unless the new enabled setting is
explicitly false, and selects the `monitor` role when `WALLET_INFRA_ROLE` is
unset. The former monitor wrapper's `CHAIN`, `MAIN_KNEX_DB_CONNECTION`, and
`TEST_KNEX_DB_CONNECTION` names are also accepted when their current
`BSV_NETWORK` or `KNEX_DB_CONNECTION` counterparts are absent.

---

## Deployment Options

Wallet Infra offers two main deployment paths, depending on your needs:

### Local Development

For quickly iterating on features and testing your wallet backend locally, follow the [**Local Development Guide**](./guides/local_development.md). This will walk you through spinning up a Docker Compose environment with MySQL and the Node.js server in minutes.

### Google Cloud Run Deployment

If you prefer a serverless, production-grade setup, follow the [**Google Cloud Deployment Guide**](./guides/gcloud_deployment.md) for detailed instructions on:

- Creating a MySQL database on Cloud SQL (or using your own DB)
- Building and pushing the Docker image to Google Cloud
- Deploying to Cloud Run with environment variables
- Optional CI/CD with GitHub Actions

---

## License

The license for the code in this repository is the Open BSV License. Refer to [LICENSE.txt](./LICENSE.txt) for the license text.
