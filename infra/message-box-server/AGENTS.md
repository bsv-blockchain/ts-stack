# CLAUDE.md — Message Box Server

## Purpose
A secure peer-to-peer message routing server for the Bitcoin SV ecosystem. Provides identity-based message delivery, real-time WebSocket communication, and full mutual authentication using BRC-103 signatures. Messages are encrypted and stored until acknowledged, supporting both HTTP and WebSocket transports.

## Service surface
- **POST /sendMessage** – Send encrypted message to a recipient's message box
- **POST /listMessages** – List all unacknowledged messages in a box (authenticated)
- **POST /acknowledgeMessage** – Mark messages as read/delete them (authenticated)
- **WebSocket** – Real-time authenticated messaging over `@bsv/authsocket` using rooms in format `{identityKey}-{messageBox}`
  - Events: `authenticated`, `joinRoom`, `sendMessage`, `leaveRoom`
- **Background jobs** – Firebase push notifications (optional, enabled via ENABLE_FIREBASE)

## Real deployment
- **Dockerfile** – Multi-stage build: node:20-alpine builder → production runtime with nginx reverse proxy on port 8080 (app runs on 3000, nginx on 8080)
- **docker-compose.yml** – Backend (Node), MySQL 8.0, PHPMyAdmin. MySQL connection pool with health checks
- **knexfile.ts** – MySQL 8.0 via mysql2, default connection string configurable via KNEX_DB_CONNECTION
- **nginx.conf** – HTTP/2 reverse proxy listening on 8080, proxying to localhost:3000, gzip enabled, 1GB max body size
- **Migrations** – Knex migrations stored in `src/migrations/`:
  - `2022-12-28-001-initial-migration.ts` – Core messages table with identity keys
  - `2023-01-17-messages-update.ts` – Payload storage updates
  - `2024-03-05-001-messageID-upgrade.ts` – MessageID uniqueness constraints
  - `2025-01-31-001-notification-permissions.ts` – Firebase notification permissions
  - `2025-01-31-002-device-registrations.ts` – Device registration tracking

## Configuration
Environment variables (from `.env.example`):
- **NODE_ENV** – `development`, `staging`, or `production`
- **PORT** – Express port (default 3000 prod, 8080 dev)
- **HTTP_PORT** – Alternative port alias
- **HOSTING_DOMAIN** – Public domain for overlay advertisement (e.g., `http://localhost:8080`)
- **SERVER_PRIVATE_KEY** – 256-bit hex private key for server identity and auth signing (required)
- **ROUTING_PREFIX** – Optional path prefix for all routes (e.g., `/api`)
- **ENABLE_WEBSOCKETS** – Set to `'true'` to enable real-time messaging (default true)
- **LOGGING_ENABLED** – Set to `'true'` for verbose debug logging
- **WALLET_STORAGE_URL** – URL of wallet storage service (e.g., `https://storage.babbage.systems`)
- **KNEX_DB_CLIENT** – Database client (default: `mysql`)
- **KNEX_DB_CONNECTION** – JSON connection config: `{"host":"localhost","port":3306,"user":"root","password":"...","database":"messagebox-backend"}`
- **MIGRATE_KEY** – Optional key to authorize migration operations
- **ENABLE_FIREBASE** – Set to `'true'` to enable Firebase push notifications
- **FIREBASE_PROJECT_ID** – GCP project ID for Firebase
- **FIREBASE_SERVICE_ACCOUNT_JSON** – Firebase service account JSON (inline)
- **FIREBASE_SERVICE_ACCOUNT_PATH** – Path to Firebase service account JSON file

## Dependencies
- **Database** – MySQL 8.0 via knex + mysql2
- **@bsv packages**
  - `@bsv/sdk` – Cryptography, key handling
  - `@bsv/auth-express-middleware` – BRC-103 request/response authentication
  - `@bsv/authsocket` – Authenticated WebSocket server
  - `@bsv/payment-express-middleware` – Optional payment verification
  - `@bsv/wallet-toolbox` – Wallet operations
- **External services**
  - Wallet Storage (via `WALLET_STORAGE_URL`) – Stores key derivation metadata
  - Firebase Admin SDK (optional) – Push notifications to registered devices
- **Key packages** – Express, body-parser, dotenv, socket.io (WebSocket), web-push, firebase-admin, swagger-jsdoc

## Operational concerns
- **Local dev** – `npm run dev` with hot-reload via nodemon, requires MySQL running (use docker-compose)
- **Production** – `npm run build && npm start` compiles TypeScript to `out/`, then `node out/src/index.js` starts
- **Migrations** – Auto-run after server starts (5s delay in code); use `MIGRATE_KEY` to authorize if needed
- **Health endpoint** – No explicit health check route; monitor WebSocket and HTTP endpoints
- **Scaling** – Single instance by design; WebSocket rooms are in-memory, horizontal scaling requires sticky sessions or external message broker
- **Database** – MySQL 8.0 required; note query performance with large message volumes (index on identity keys + messageBox)
- **WebSocket** – `@bsv/authsocket` handles multiplexing; each client connects once but can join multiple rooms

## Spec conformance
- **BRC-103** – Mutual authentication on all requests and WebSocket handshakes
- **BRC-2** – Optional AES-encrypted message payloads (client-side encryption supported)
- **SHIP** – Overlay advertisement via `@bsv/sdk` PublicKey operations
- **MessageBox protocol** – Custom identity + messageBox type routing model

## Integration points
- **@bsv/messagebox-client** – Client library that connects to this server, handles auth, encryption, WebSocket
- **Wallet Storage** – Derives keys from SERVER_PRIVATE_KEY via configured wallet storage endpoint
- **Overlay nodes** – Can advertise MessageBox capabilities via SHIP protocol using HOSTING_DOMAIN
- **Payment processing** – Optionally enforces BRC-100 payment verification on message send (via `@bsv/payment-express-middleware`)

## File map
- **src/**
  - `index.ts` – Entry point: loads env, creates HTTP + WebSocket servers, starts migrations
  - `app.ts` – Express app setup, route mounting, auth middleware
  - `routes/` – HTTP endpoints: `sendMessage.ts`, `listMessages.ts`, `acknowledgeMessage.ts`, device listing, permissions
  - `config/firebase.ts` – Firebase Admin SDK initialization
  - `utils/` – Helpers: logger, notification sending, message permissions
  - `migrations/` – Knex schema migrations for messages, permissions, devices
  - `types/` – TypeScript interfaces for notifications, permissions
- **knexfile.ts** – Knex configuration, driver selection, connection pooling
- **Dockerfile** – Multi-stage Node + nginx container
- **docker-compose.yml** – Services: backend, MySQL, PHPMyAdmin
- **nginx.conf** – Reverse proxy config
- **.env.example** – Template with all required/optional variables
