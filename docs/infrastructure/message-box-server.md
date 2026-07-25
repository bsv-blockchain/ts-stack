---
id: infra-message-box-server
title: "Message-box Server"
kind: infra
version: "1.1.14"
last_updated: "2026-07-25"
last_verified: "2026-07-25"
review_cadence_days: 30
status: stable
tags: [messaging, overlay, store-and-forward, authentication]
---

# Message Box Server

> A secure peer-to-peer message routing server for the Bitcoin SV ecosystem. Provides identity-based message delivery, real-time WebSocket communication, and full mutual authentication using BRC-103 signatures.

## What it does

The Message Box Server implements encrypted, store-and-forward messaging with support for both HTTP and WebSocket transports. Messages are identified by sender identity keys and recipient message boxes, encrypted end-to-end, and stored in MySQL until acknowledged by the recipient. The server speaks HTTP and WebSocket protocols, maintains connection state via `@bsv/authsocket` rooms, and can emit Firebase push notifications to registered devices.

Clients connect with identity-based authentication, send and receive messages through authenticated endpoints, and can opt into real-time WebSocket delivery for immediate notifications.

## When to deploy this

- Building peer-to-peer messaging applications on BSV
- You need encrypted, identity-based message delivery
- Supporting both HTTP polling and real-time WebSocket clients
- Requiring Firebase push notifications to mobile devices

## Dependencies

| Type | Requirement |
|------|-------------|
| Database | MySQL 8.0 via mysql2 |
| External services | Wallet Storage (WALLET_STORAGE_URL), Firebase Admin SDK (optional) |
| ts-stack packages | @bsv/sdk, @bsv/auth-express-middleware, @bsv/authsocket, @bsv/payment-express-middleware, @bsv/wallet-toolbox |

## HTTP endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | /sendMessage | Send encrypted message to recipient (authenticated) |
| POST | /listMessages | List all unacknowledged messages in box (authenticated) |
| POST | /acknowledgeMessage | Mark messages as read/delete them (authenticated) |
| POST | /registerDevice | Register a push-notification device for the authenticated identity |
| GET | /devices | List the authenticated identity's devices with redacted tokens |
| GET | /permissions/get | Read a recipient permission |
| GET | /permissions/list | List recipient permissions |
| GET | /permissions/quote | Quote up to 100 recipients |
| POST | /permissions/set | Set an authenticated recipient permission |
| GET | /docs, /openapi.json | Public API documentation |

## WebSocket endpoints

- **ws://host:8080** – Authenticated WebSocket server using @bsv/authsocket
  - Subscription names: `{identityKey}-{messageBox}` format
  - Events: `authenticated`, `joinRoom`, `sendMessage`, `leaveRoom`
  - Payload identity claims must match the BRC-103 peer identity
  - Notifications are routed only to authenticated recipient connections; sends reuse the HTTP validation, permission, fee, and persistence policy

## Configuration (env vars)

| Variable | Required | Description |
|----------|----------|-------------|
| NODE_ENV | No | `development`, `staging`, or `production` |
| PORT | No | Express port (default 3000 prod, 8080 dev) |
| HTTP_PORT | No | Alternative port alias |
| HOSTING_DOMAIN | No | Public domain for overlay advertisement (e.g., `http://localhost:8080`) |
| SERVER_PRIVATE_KEY | Yes | 256-bit hex private key for server identity and auth signing |
| ROUTING_PREFIX | No | Optional path prefix for all routes (e.g., `/api`) |
| ENABLE_WEBSOCKETS | No | Set to `'true'` to enable real-time messaging (default true) |
| LOGGING_ENABLED | No | Set to `'true'` for verbose debug logging |
| WALLET_STORAGE_URL | No | URL of wallet storage service (e.g., `https://store-us-1.bsvb.tech`) |
| KNEX_DB_CLIENT | No | Database client (default: `mysql`) |
| KNEX_DB_CONNECTION | Yes | JSON connection config: `{"host":"localhost","port":3306,"user":"root","password":"...","database":"messagebox-backend"}` |
| MIGRATE_KEY | No | Optional key to authorize migration operations |
| ENABLE_FIREBASE | No | Set to `'true'` to enable Firebase push notifications |
| FIREBASE_PROJECT_ID | No | GCP project ID for Firebase |
| FIREBASE_SERVICE_ACCOUNT_JSON | No | Firebase service account JSON (inline) |
| FIREBASE_SERVICE_ACCOUNT_PATH | No | Path to Firebase service account JSON file |
| MESSAGE_BOX_CORS_MODE | No | `public` (default), `allowlist`, or `disabled` |
| MESSAGE_BOX_CORS_ALLOWED_ORIGINS | No | Exact comma-separated origins in allowlist mode |
| MESSAGE_BOX_MAX_BODY_BYTES | No | HTTP JSON ceiling (default 4194304) |
| MESSAGE_BOX_WEBSOCKET_MAX_BODY_BYTES | No | WebSocket payload ceiling (default 1048576) |

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

# Run with nginx reverse proxy on port 8080
docker run -d \
  -e NODE_ENV=production \
  -e SERVER_PRIVATE_KEY=<hex-key> \
  -e KNEX_DB_CONNECTION='{"host":"mysql","port":3306,"user":"root","password":"...","database":"messagebox-backend"}' \
  -e ENABLE_WEBSOCKETS=true \
  -p 8080:8080 \
  messagebox:latest

# Or use docker-compose (app runs on 3000, nginx on 8080)
docker compose up -d
```

The multi-stage Dockerfile compiles TypeScript for a minimal production
runtime. Nginx proxies to the app with a 4 MiB body ceiling and bounded
header/body/send/upstream timeouts.

## Migrations

Knex migrations run automatically on server startup with 5-second delay. To run manually:

```bash
npm run migrate
```

Migrations tracked in `src/migrations/`:
- `2022-12-28-001-initial-migration.ts` – Core messages table with identity keys
- `2023-01-17-messages-update.ts` – Payload storage updates
- `2024-03-05-001-messageID-upgrade.ts` – MessageID uniqueness constraints
- `2025-01-31-001-notification-permissions.ts` – Firebase notification permissions
- `2025-01-31-002-device-registrations.ts` – Device registration tracking

## Health checks

No explicit health endpoint; monitor via:
- **WebSocket connectivity** – Test authenticated WebSocket handshake
- **HTTP endpoints** – POST /listMessages returns 200 for authenticated clients
- **Database** – Query availability of messages table

## Spec conformance

- **BRC-103** – Mutual authentication on all HTTP requests and WebSocket handshakes
- **BRC-2** – Optional AES-encrypted message payloads (client-side encryption supported)
- **SHIP** – Overlay advertisement via @bsv/sdk PublicKey operations
- **MessageBox protocol** – Custom identity + messageBox type routing model

## Integration with ts-stack

- Clients connect via `@bsv/messagebox-client` library
- Uses Wallet Storage for key derivation from SERVER_PRIVATE_KEY
- Advertises MessageBox capabilities to overlay nodes via SHIP protocol using HOSTING_DOMAIN
- Optionally enforces BRC-100 payment verification on message send via `@bsv/payment-express-middleware`

## Common pitfalls

- WebSocket scaling: authenticated connection routing is per process; use sticky sessions or an authenticated external broker for horizontal scaling
- Database indexing: Ensure indexes on identity keys + messageBox for high-volume deployments
- Firebase setup: Requires valid service account JSON; Firebase push disabled if misconfigured
- Private key generation: Must be 256-bit hex; asymmetric key used for mutual auth signing
- Migration delays: Auto-run happens with 5-second delay; use MIGRATE_KEY to authorize if needed

## Source

- [GitHub](https://github.com/bsv-blockchain/ts-stack/tree/main/infra/message-box-server)
- [npm package](https://npmjs.com/package/@bsv/messagebox-server)
