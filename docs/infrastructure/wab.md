---
id: infra-wab
title: "Wallet Authentication Backend (WAB)"
kind: infra
version: "1.4.10"
last_updated: "2026-07-25"
last_verified: "2026-07-25"
review_cadence_days: 30
status: stable
tags: [wallet, authentication, mfa, presentation-keys, bsv-wallet]
---

# Wallet Authentication Backend (WAB)

> A TypeScript/Express server that provides presentation-key and Shamir-share recovery workflows for BSV wallet applications, using Twilio verification in production and an explicitly development-only console OTP method.

## What it does

WAB enables Twilio phone verification and coordinates key/share storage through
SQLite (development) or MySQL (production). A Persona example exists in source
but is not registered as a supported method. The DevConsole method is available
only when explicitly enabled in a `development` or `test` runtime and cannot be
activated in production or staging.

Clients authenticate by phone number, recover original presentation keys, and optionally receive one-time BSV payments.

## When to deploy this

- BSV wallet applications needing multi-factor user authentication
- Key recovery using 2-of-3 threshold system (presentation key + password + recovery key)
- Development/testing with OTP-based console auth
- Production deployments with Twilio SMS verification
- Faucet distribution for new users (with SERVER_PRIVATE_KEY and STORAGE_URL)

## Dependencies

| Type | Requirement |
|------|-------------|
| Database | SQLite (dev: ./dev.sqlite3) or MySQL (production: DB_CLIENT, DB_USER, DB_PASS, DB_NAME, DB_HOST, DB_PORT) |
| External services | Twilio (if TwilioAuthMethod), Wallet Storage (if faucet enabled), ARC (for transaction broadcasting) |
| ts-stack packages | @bsv/sdk, @bsv/wallet-toolbox |

## HTTP endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | /info | Server configuration info |
| POST | /auth/start | Start authentication (methodType, presentationKey, payload) |
| POST | /auth/complete | Complete authentication (methodType, presentationKey, payload) |
| POST | /user/linkedMethods | List user's linked auth methods (presentationKey) |
| POST | /user/unlinkMethod | Unlink auth method (presentationKey, methodId) |
| POST | /user/delete | Delete user account (presentationKey) |
| POST | /faucet/request | Request faucet payment (presentationKey) |
| POST | /account/delete/start | Start OTP-confirmed account deletion |
| POST | /account/delete/complete | Complete account deletion |
| POST | /share/store | OTP-confirmed Shamir share creation |
| POST | /share/retrieve | OTP-confirmed Shamir share recovery |
| POST | /share/update | OTP-confirmed Shamir share rotation |
| POST | /share/delete | OTP-confirmed share/account deletion |

## WebSocket endpoints

None.

## Configuration (env vars)

| Variable | Required | Description |
|----------|----------|-------------|
| NODE_ENV | No | `development` or `production` |
| PORT | No | HTTP server port (default: 3000) |
| TWILIO_ACCOUNT_SID | No | Twilio account ID (if using TwilioAuthMethod) |
| TWILIO_AUTH_TOKEN | No | Twilio auth token |
| TWILIO_VERIFY_SERVICE_SID | No | Twilio Verify service ID (VAxxxx or VExxxx) |
| SERVER_PRIVATE_KEY | No | 256-bit hex key for faucet transactions |
| STORAGE_URL | No | Overlay services URL for faucet (e.g., wallet storage endpoint) |
| COMMISSION_FEE | No | Commission fee in satoshis per faucet request (default: 0) |
| DB_CLIENT | No | Database client (default: sqlite3; or mysql2) |
| DB_USER | No | Database user (production MySQL) |
| DB_PASS | No | Database password |
| DB_NAME | No | Database name |
| DB_HOST | No | Database host |
| DB_PORT | No | Database port |
| DB_CONNECTION_NAME | No | GCP Cloud SQL connection name (for Cloud SQL with Unix socket) |
| DEV_CONSOLE_AUTH_METHOD_ENABLED | No | Development/test-only explicit console OTP opt-in |
| WAB_CORS_MODE | No | `public` (default), `allowlist`, or `disabled` |
| WAB_CORS_ALLOWED_ORIGINS | No | Exact comma-separated origins for allowlist mode |
| WAB_MAX_BODY_BYTES | No | JSON body ceiling (default 262144) |
| WAB_MAX_CONCURRENT_REQUESTS | No | Per-process in-flight ceiling (default 200) |
| TRUST_PROXY_HOPS | No | Exact trusted proxy hop count, 0 through 10 |

See [Public Service Edge Security](service-edge-security.md#wab) for endpoint
rate limits, errors, CORS/CSP behavior, and the threat model.

## Run locally

```bash
# Install dependencies
npm install

# Development with auto-restart
npm run dev

# Database migrations
npm run migrate

# Run tests with coverage
npm test

# Build TypeScript
npm run build

# Run production server
npm start
```

Uses SQLite by default (./dev.sqlite3); MySQL configured via DB_* env vars.

## Deploy to production

```bash
# Build Docker image
docker build -t wab-server:latest .

# Run with MySQL backend
docker run -d \
  -e NODE_ENV=production \
  -e DB_CLIENT=mysql2 \
  -e DB_HOST=mysql \
  -e DB_USER=root \
  -e DB_PASS=password \
  -e DB_NAME=wab \
  -e TWILIO_ACCOUNT_SID=<sid> \
  -e TWILIO_AUTH_TOKEN=<token> \
  -e TWILIO_VERIFY_SERVICE_SID=<service-id> \
  -e SERVER_PRIVATE_KEY=<hex-key> \
  -e STORAGE_URL=<overlay-url> \
  -p 3000:3000 \
  wab-server:latest

# Or with GCP Cloud SQL
docker run -d \
  -e DB_CLIENT=mysql2 \
  -e DB_CONNECTION_NAME=project:region:instance \
  -e DB_USER=root \
  -e DB_PASS=password \
  -e DB_NAME=wab \
  ... (other env vars)

# Or via docker-compose with MySQL
docker compose up -d
```

## Migrations

Run Knex migrations for schema initialization:

```bash
npm run migrate
```

Creates tables: users (id, presentationKey), auth_methods (id, userId, methodType, config), payments (id, userId, beef, k, txid, amount, outputIndex).

## Health checks

No explicit health endpoint. Monitor:
- Database connectivity (run `npm run migrate` to verify)
- Auth method configuration (Twilio credentials, etc.)
- POST /auth/start endpoint responds with 200/4xx

## Spec conformance

- **BRC-100** – Optional integration with @bsv/wallet-toolbox for faucet R-puzzle transactions
- **2-of-3 Recovery** – Presentation key is factor #1 (password #2, recovery key #3) in XOR-based derivation system

## Integration with ts-stack

- Clients implement AuthMethod subclasses for custom verification flows
- Wallet Toolbox integration for faucet BSV payments and key derivation
- WalletAuthenticationManager uses WAB for presentation key authentication
- UMP (User Management Protocol) token system coordinates with presentation keys
- See how-it-works.md for detailed 2-of-3 cryptographic recovery explanation

## Common pitfalls

- User identification by config, not presentation key: Auth method's buildConfigFromPayload() extracts unique identifier (e.g., phone number); two devices with same phone return same user's key
- Twilio setup critical: TWILIO_VERIFY_SERVICE_SID must be VAxxxx (Verify) or VExxxx (Verify Email); wrong SID causes all auth attempts to fail
- SQLite for dev only: In-memory tables reset on restart; switch to MySQL for production
- Faucet requires funds: SERVER_PRIVATE_KEY wallet must have UTXOs; transactions fail if insufficient balance
- Dev console is ephemeral: its OTP store resets on restart and is intentionally unavailable in production/staging
- Public CORS is intentional for wallet apps on unknown domains; use `WAB_CORS_MODE=allowlist` only when the deployment has a closed caller set
- Migration timing: Must run before server startup; Knex handles schema versioning automatically

## Source

- [GitHub](https://github.com/bsv-blockchain/ts-stack/tree/main/infra/wab)
- [npm package](https://npmjs.com/package/@bsv/wab-server)
