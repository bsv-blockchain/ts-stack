---
id: infra-message-box-server
title: "Message-box Server"
kind: infra
version: "1.1.5"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
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

## WebSocket endpoints

- **ws://host:8080** – Authenticated WebSocket server using @bsv/authsocket
  - Rooms: `{identityKey}-{messageBox}` format
  - Events: `authenticated`, `joinRoom`, `sendMessage`, `leaveRoom`
  - Real-time message delivery and notifications

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
| WALLET_STORAGE_URL | No | URL of wallet storage service (e.g., `https://storage.babbage.systems`) |
| KNEX_DB_CLIENT | No | Database client (default: `mysql`) |
| KNEX_DB_CONNECTION | Yes | JSON connection config: `{"host":"localhost","port":3306,"user":"root","password":"...","database":"messagebox-backend"}` |
| MIGRATE_KEY | No | Optional key to authorize migration operations |
| ENABLE_FIREBASE | No | Set to `'true'` to enable Firebase push notifications |
| FIREBASE_PROJECT_ID | No | GCP project ID for Firebase |
| FIREBASE_SERVICE_ACCOUNT_JSON | No | Firebase service account JSON (inline) |
| FIREBASE_SERVICE_ACCOUNT_PATH | No | Path to Firebase service account JSON file |

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

Multi-stage Dockerfile compiles TypeScript to `out/` with Node 20-alpine builder, then runs in production runtime. Nginx reverse proxy listens on 8080, proxies to app on 3000, with HTTP/2, gzip compression, and 1GB max body size.

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

- WebSocket scaling: In-memory rooms require sticky sessions or external message broker for horizontal scaling
- Database indexing: Ensure indexes on identity keys + messageBox for high-volume deployments
- Firebase setup: Requires valid service account JSON; Firebase push disabled if misconfigured
- Private key generation: Must be 256-bit hex; asymmetric key used for mutual auth signing
- Migration delays: Auto-run happens with 5-second delay; use MIGRATE_KEY to authorize if needed

## Source

- [GitHub](https://github.com/bsv-stack/message-box-server)
- [npm package](https://npmjs.com/package/@bsv/messagebox-server)
