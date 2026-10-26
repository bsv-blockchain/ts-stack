---
id: infra-message-box-server
title: 'Message-box Server'
kind: infra
version: '1.1.43'
last_updated: '2026-10-16'
last_verified: '2026-10-16'
review_cadence_days: 30
status: stable
tags: [messaging, overlay, store-and-forward, authentication]
---

# Message Box Server

> A secure peer-to-peer message routing server for the Bitcoin SV ecosystem. Provides identity-based message delivery, real-time WebSocket communication, and full mutual authentication using BRC-103 signatures.

## Privacy Notice

Message Box encrypts message content end to end between sender and recipient, so the host operator cannot read what you send. Private keys never leave your wallet, and the server returns messages only after it authenticates the recipient's identity key.

To deliver messages, the operator can still see some metadata: when messages are sent and received, message size, and which identity keys (pseudonyms) exchange messages with each other, and the IP addresses that connect. Identity keys are not names, but repeated use can link activity over time.

This balance keeps delivery simple and reliable while keeping content private. If unlinkability matters to you, use separate identity keys for each context or run your own Message Box server.

## What it does

The Message Box Server implements encrypted, store-and-forward messaging with support for both HTTP and WebSocket transports. Messages are identified by sender identity keys and recipient message boxes, encrypted end-to-end, and stored in MySQL until acknowledged by the recipient. The server speaks HTTP and WebSocket protocols, maintains connection state via `@bsv/authsocket` rooms, and can emit Firebase push notifications to registered devices.

Clients connect with identity-based authentication, send and receive messages through authenticated endpoints, and can opt into real-time WebSocket delivery for immediate notifications.

## When to deploy this

- Building peer-to-peer messaging applications on BSV
- You need encrypted, identity-based message delivery
- Supporting both HTTP polling and real-time WebSocket clients
- Requiring Firebase push notifications to mobile devices

## Dependencies

| Type              | Requirement                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------- |
| Database          | MySQL 8.0 via mysql2                                                                                          |
| External services | Wallet Storage (WALLET_STORAGE_URL), Firebase Admin SDK (optional)                                            |
| ts-stack packages | @bsv/sdk, @bsv/auth-express-middleware, @bsv/authsocket, @bsv/payment-express-middleware, @bsv/wallet-toolbox |

## HTTP endpoints

| Method | Path                 | Purpose                                                            |
| ------ | -------------------- | ------------------------------------------------------------------ |
| POST   | /sendMessage         | Send encrypted message to recipient (authenticated)                |
| POST   | /listMessages        | Page unacknowledged messages with `limit` and `offset`/`skip`      |
| POST   | /acknowledgeMessage  | Mark messages as read/delete them (authenticated)                  |
| POST   | /registerDevice      | Register a push-notification device for the authenticated identity |
| GET    | /devices             | List the authenticated identity's devices with redacted tokens     |
| GET    | /permissions/get     | Read a recipient permission                                        |
| GET    | /permissions/list    | List recipient permissions                                         |
| GET    | /permissions/quote   | Quote up to 100 recipients                                         |
| POST   | /permissions/set     | Set an authenticated recipient permission                          |
| GET    | /health              | Public process liveness                                            |
| GET    | /ready               | Public database readiness                                          |
| GET    | /docs, /openapi.json | Public API documentation                                           |

The omitted page size is 1,000 in the standard profile and is operator
configurable. Responses include `limit`, `offset`, `nextOffset`, and `hasMore`.
See [Service Resource Profiles](../reference/service-resource-profiles.md) for
all limits, shared state, BRC-105 pricing, memory evidence, and scaling guidance.

## WebSocket endpoints

- **ws://host:8080** – Authenticated WebSocket server using @bsv/authsocket
  - Subscription names: `{identityKey}-{messageBox}` format
  - Events: `authenticated`, `joinRoom`, `sendMessage`, `leaveRoom`
  - Payload identity claims must match the BRC-103 peer identity
  - Notifications are routed only to authenticated recipient connections; sends reuse the HTTP validation, permission, fee, and persistence policy

## Configuration (env vars)

| Variable                             | Required | Description                                                                                                               |
| ------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| NODE_ENV                             | No       | `development`, `staging`, or `production`                                                                                 |
| BSV_NETWORK                          | No       | `mainnet`, `testnet`, `ttn`, or `teratestnet` (default `mainnet`)                                                      |
| PORT                                 | No       | HTTP/WebSocket port (default 8080; takes precedence)                                                                      |
| HTTP_PORT                            | No       | Compatibility port fallback                                                                                               |
| HOSTING_DOMAIN                       | No       | Public domain for overlay advertisement (e.g., `http://localhost:8080`)                                                   |
| SERVER_PRIVATE_KEY                   | Yes      | 256-bit hex private key for server identity and auth signing                                                              |
| ROUTING_PREFIX                       | No       | Optional path prefix for all routes (e.g., `/api`)                                                                        |
| ENABLE_WEBSOCKETS                    | No       | Set to `'true'` to enable real-time messaging (default true)                                                              |
| LOGGING_ENABLED                      | No       | Set to `'true'` for verbose debug logging                                                                                 |
| WALLET_STORAGE_URL                   | No       | URL of wallet storage service (e.g., `https://store-us-1.bsvb.tech`)                                                      |
| KNEX_DB_CLIENT                       | No       | Database client (default: `mysql`)                                                                                        |
| KNEX_DB_CONNECTION                   | Yes      | JSON connection config: `{"host":"localhost","port":3306,"user":"root","password":"...","database":"messagebox-backend"}` |
| MIGRATE_KEY                          | No       | Optional key to authorize migration operations                                                                            |
| ENABLE_FIREBASE                      | No       | Set to `'true'` to enable Firebase push notifications                                                                     |
| FIREBASE_PROJECT_ID                  | No       | GCP project ID for Firebase                                                                                               |
| FIREBASE_SERVICE_ACCOUNT_JSON        | No       | Firebase service account JSON (inline)                                                                                    |
| FIREBASE_SERVICE_ACCOUNT_PATH        | No       | Path to Firebase service account JSON file                                                                                |
| MESSAGE_BOX_CORS_MODE                | No       | `public` (default), `allowlist`, or `disabled`                                                                            |
| MESSAGE_BOX_CORS_ALLOWED_ORIGINS     | No       | Exact comma-separated origins in allowlist mode                                                                           |
| MESSAGE_BOX_CORS_ALLOWED_HEADERS     | No       | Strict comma-separated browser request-header allowlist; omit for additive compatibility                                  |
| MESSAGE_BOX_MAX_BODY_BYTES           | No       | HTTP JSON ceiling (default 4194304)                                                                                       |
| MESSAGE_BOX_WEBSOCKET_MAX_BODY_BYTES | No       | WebSocket payload ceiling (default 1048576)                                                                               |

See [Public Service Edge Security](service-edge-security.md#message-box) for
rate, timeout, WebSocket authorization, CORS/CSP, and error controls.

## Run locally

```bash
# Install dependencies
npm install

# Development with hot-reload
npm run dev

# Database setup (MySQL 8.0 running)
docker compose up -d mysql

# Build for production
npm run build

# Run production build
npm start
```

## Deploy to production

```bash
# Build Docker image
docker build -t messagebox:latest .

# Run the service directly on port 8080
docker run -d \
  -e NODE_ENV=production \
  -e PORT=8080 \
  -e SERVER_PRIVATE_KEY=<hex-key> \
  -e KNEX_DB_CONNECTION='{"host":"mysql","port":3306,"user":"root","password":"...","database":"messagebox-backend"}' \
  -e ENABLE_WEBSOCKETS=true \
  -p 8080:8080 \
  messagebox:latest

# Or use docker-compose
docker compose up -d
```

The multi-stage Dockerfile compiles TypeScript for a minimal production
runtime. The Node process serves HTTP and WebSocket traffic directly; deploy a
trusted platform ingress or load balancer in front when required.

## Migrations

Knex migrations run automatically at server startup. After building, they can
also be run manually:

```bash
npx --no-install knex --knexfile out/knexfile.js migrate:latest --env production
```

Migrations tracked in `src/migrations/`:

- `2022-12-28-001-initial-migration.ts` – Core messages table with identity keys
- `2023-01-17-messages-update.ts` – Payload storage updates
- `2024-03-05-001-messageID-upgrade.ts` – MessageID uniqueness constraints
- `2025-01-31-001-notification-permissions.ts` – Firebase notification permissions
- `2025-01-31-002-device-registrations.ts` – Device registration tracking
- `2026-07-26-001-message-permission-scope.ts` – Enforce one box-wide or sender-specific permission per scope
- `2026-07-26-002-list-query-indexes.ts` – Add indexes for bounded inbox and sender-list queries
- `2026-08-04-001-resource-safety.ts` – Add retained-state accounting, resource-safety fields, and durable payment replay claims
- `2026-09-21-001-message-payment-intents.ts` – Bind paid sends to exact requests and preserve cross-boundary recovery state

Preserve both `payment_replays` and `message_payment_intents` across rollouts.
For body payments, the replay claim is non-expiring. An intent advances from
`prepared` to `wallet_accepted` to `completed`; an ambiguous `prepared` intent
after process termination requires reconciliation against the wallet before
retrying. Do not delete or reassign an intent to force a retry. The down
migration refuses to drop a populated intent table, and an older image cannot
safely interpret this recovery protocol. Prefer roll-forward; if rollback is
unavoidable, drain all replicas, reconcile every intent, and restore the prior
image together with a verified pre-migration database backup. See the
[deployment guide](https://github.com/bsv-blockchain/ts-stack/blob/main/infra/message-box-server/DEPLOYING.md#database-migrations)
for the full recovery and rollback procedure.

Periodic snapshots provide the general message/permission RPO, but paid sends
require zero silent loss of replay and intent evidence. Retain continuous
point-in-time/binlog history and independent wallet transaction/audit evidence
from each snapshot through the present. After a restore, keep paid sends
disabled until every post-snapshot wallet action, replay claim, and intent has
been reconstructed and reconciled; an unresolved interval must not be retried
or converted into a second payment request.

## Health checks

- `GET /health` and `GET /healthz` report process liveness without authentication.
- `GET /ready` verifies database connectivity and returns a non-sensitive 503
  response while dependencies are unavailable.
- Test an authenticated WebSocket handshake separately when live transport is
  enabled.

## Spec conformance

- **BRC-103** – Mutual authentication on all HTTP requests and WebSocket handshakes
- **BRC-2** – Optional AES-encrypted message payloads (client-side encryption supported)
- **SHIP** – Overlay advertisement via @bsv/sdk PublicKey operations
- **MessageBox protocol** – Custom identity + messageBox type routing model

## Integration with ts-stack

- Clients connect via `@bsv/message-box-client`
- Uses Wallet Storage for key derivation from SERVER_PRIVATE_KEY
- Advertises MessageBox capabilities to overlay nodes via SHIP protocol using HOSTING_DOMAIN
- Enforces configured BRC-100/BRC-105 payment policy and atomically binds each accepted body payment to the exact message request through durable replay claims and payment intents

## Common pitfalls

- WebSocket scaling: authenticated connection routing is per process; use sticky sessions or an authenticated external broker for horizontal scaling
- Database indexing: Ensure indexes on identity keys + messageBox for high-volume deployments
- Firebase setup: Requires valid service account JSON; Firebase push disabled if misconfigured
- Private key generation: Must be 256-bit hex; asymmetric key used for mutual auth signing
- Migration failures prevent the process from accepting traffic; deployments
  should still gate traffic on `/ready`.
- Image-only rollback after the payment-intent migration is unsafe; follow the
  documented database recovery procedure instead.

## Source

- [GitHub](https://github.com/bsv-blockchain/ts-stack/tree/main/infra/message-box-server)

The service package is private and is distributed as a container, not as a
public npm package.
