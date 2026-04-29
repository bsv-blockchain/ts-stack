---
id: infra-wab
title: "Wallet Abstraction Backend (WAB)"
kind: infra
version: "1.4.1"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
status: stable
tags: [wallet, authentication, mfa, presentation-keys, bsv-wallet]
---

# Wallet Abstraction Backend (WAB)

> A TypeScript/Express server that provides multi-factor authentication for BSV wallet applications. Manages 256-bit presentation keys for users, authenticated via SMS (Twilio), ID verification (Persona), or dev console, as part of a 2-of-3 threshold cryptographic recovery system.

## What it does

The Wallet Abstraction Backend (WAB) implements three auth methods (TwilioAuthMethod, PersonaAuthMethod, DevConsoleAuthMethod) and coordinates key storage via a UserService backed by SQLite (dev) or MySQL (production). Clients request authentication via /auth/start with a presentation key, an external service verifies identity (phone number via SMS, ID document verification, or console OTP), then clients complete authentication via /auth/complete with the verification code. The server looks up existing users by verified identity (phone number, etc.) and returns their stored presentation key, or creates new users. Supports endpoints for managing linked auth methods, deleting users, and requesting faucet payments using R-puzzle transactions.

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
- Auth methods are singletons: DevConsoleAuthMethod uses in-memory state; reset on service restart
- CORS permissive: All origins/headers allowed; apply restrictive CORS in production via reverse proxy
- Migration timing: Must run before server startup; Knex handles schema versioning automatically

## Source

- [GitHub](https://github.com/bsv-stack/wab-server)
- [npm package](https://npmjs.com/package/@bsv/wab-server)
