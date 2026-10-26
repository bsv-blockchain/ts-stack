---
id: infra-wab
title: 'Wallet Authentication Backend (WAB)'
kind: infra
version: '1.8.3'
last_updated: '2026-09-21'
last_verified: '2026-09-21'
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

Clients authenticate by phone number, recover original presentation keys,
optionally receive one-time BSV payments, and can verify a same-or-new phone
number to rotate the presentation key. Operators can pin a legacy ambiguous UMP
account to one verified outpoint and restore recorded phone associations.

## When to deploy this

- BSV wallet applications needing multi-factor user authentication
- Key recovery using 2-of-3 threshold system (presentation key + password + recovery key)
- Development/testing with OTP-based console auth
- Production deployments with Twilio SMS verification
- Faucet distribution for new users (with SERVER_PRIVATE_KEY and STORAGE_URL)

## Dependencies

| Type              | Requirement                                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| Database          | SQLite (dev: ./dev.sqlite3) or MySQL (production: DB_CLIENT, DB_USER, DB_PASS, DB_NAME, DB_HOST, DB_PORT) |
| External services | Twilio (if TwilioAuthMethod), Wallet Storage (if faucet enabled), ARC (for transaction broadcasting)      |
| ts-stack packages | @bsv/sdk, @bsv/wallet-toolbox                                                                             |

## HTTP endpoints

| Method | Path                        | Purpose                                                        |
| ------ | --------------------------- | -------------------------------------------------------------- |
| GET    | /info                       | Server configuration info                                      |
| POST   | /auth/start                 | Start authentication (methodType, presentationKey, payload)    |
| POST   | /auth/complete              | Complete authentication (methodType, presentationKey, payload) |
| POST   | /auth/phone-change/start    | Verify current account and send OTP to requested phone         |
| POST   | /auth/phone-change/complete | Verify OTP and issue a ten-minute change token                 |
| POST   | /auth/phone-change/commit   | Stage the verified phone association and replacement key       |
| POST   | /auth/phone-change/finalize | Promote the key after the wallet publishes its UMP rotation    |
| POST   | /admin/ump-pin              | Set/clear a support UMP outpoint pin (admin bearer required)   |
| POST   | /admin/phone-change/restore | Restore recorded phone associations (admin bearer required)    |
| POST   | /user/linkedMethods         | List user's linked auth methods (presentationKey)              |
| POST   | /user/unlinkMethod          | Unlink auth method (presentationKey, methodId)                 |
| POST   | /user/delete                | Delete user account (presentationKey)                          |
| POST   | /faucet/request             | Request faucet payment (presentationKey)                       |
| POST   | /account/delete/start       | Start OTP-confirmed account deletion                           |
| POST   | /account/delete/complete    | Complete account deletion                                      |
| POST   | /share/store                | OTP-confirmed Shamir share creation                            |
| POST   | /share/retrieve             | OTP-confirmed Shamir share recovery                            |
| POST   | /share/update               | OTP-confirmed Shamir share rotation                            |
| POST   | /share/delete               | OTP-confirmed share/account deletion                           |

## WebSocket endpoints

None.

## Configuration (env vars)

| Variable                        | Required | Description                                                                                                               |
| ------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| NODE_ENV                        | No       | `development` or `production`                                                                                             |
| PORT                            | No       | HTTP server port (default: 8080)                                                                                          |
| TWILIO_ACCOUNT_SID              | No       | Canonical Twilio account SID (`AC` plus 32 hexadecimal characters); all three Twilio variables absent disables the method |
| TWILIO_AUTH_TOKEN               | No       | Twilio auth token; required when either Twilio SID is configured                                                          |
| TWILIO_VERIFY_SERVICE_SID       | No       | Canonical Verify Service SID (`VA` plus 32 hexadecimal characters); `VE` verification SIDs are not services               |
| SERVER_PRIVATE_KEY              | Yes      | Exact nonzero, in-range 256-bit hexadecimal private scalar for faucet transactions                                        |
| STORAGE_URL                     | Yes      | HTTPS wallet-storage URL for faucet funding; loopback HTTP is accepted only for local development                         |
| COMMISSION_FEE                  | No       | Positive safe-integer faucet amount in satoshis; unset or `0` preserves the 1,000-satoshi default                         |
| SHARE_ENCRYPTION_KEY            | Yes      | Exactly 64 hexadecimal characters (32 bytes) for AES-256-GCM share encryption; malformed values fail startup              |
| DB_CLIENT                       | No       | Database client (default: sqlite3; or mysql2)                                                                             |
| DB_USER                         | No       | Database user (production MySQL)                                                                                          |
| DB_PASS                         | No       | Database password                                                                                                         |
| DB_NAME                         | No       | Database name                                                                                                             |
| DB_HOST                         | No       | Database host                                                                                                             |
| DB_PORT                         | No       | Database port                                                                                                             |
| DB_CONNECTION_NAME              | No       | GCP Cloud SQL connection name (for Cloud SQL with Unix socket)                                                            |
| DEV_CONSOLE_AUTH_METHOD_ENABLED | No       | Development/test-only explicit console OTP opt-in                                                                         |
| WAB_CORS_MODE                   | No       | `public` (default), `allowlist`, or `disabled`                                                                            |
| WAB_CORS_ALLOWED_ORIGINS        | No       | Exact comma-separated origins for allowlist mode                                                                          |
| WAB_CORS_ALLOWED_HEADERS        | No       | Strict comma-separated browser request-header allowlist; omit to accept additive well-formed request headers              |
| WAB_MAX_BODY_BYTES              | No       | JSON body ceiling (default 262144)                                                                                        |
| WAB_MAX_CONCURRENT_REQUESTS     | No       | Per-process in-flight ceiling (default 200)                                                                               |
| WAB_ADMIN_TOKEN                 | No       | At least 32 random characters; enables authenticated `/admin/*` support routes                                            |
| WAB_ADMIN_RATE_LIMIT_MAX        | No       | Administrative requests per window (default 30)                                                                           |
| WAB_ADMIN_RATE_LIMIT_WINDOW_MS  | No       | Administrative rate-limit window (default 900000)                                                                         |
| TRUST_PROXY_HOPS                | No       | Exact trusted proxy hop count, 0 through 10                                                                               |

See [Public Service Edge Security](service-edge-security.md#wab) for endpoint
rate limits, errors, CORS/CSP behavior, and the threat model.

`SHARE_ENCRYPTION_KEY` is a long-lived data-encryption key, not an ordinary
restart secret. Keep it stable and backed up separately from the database.
Losing or replacing it makes existing recovery shares unreadable; rotation
requires an explicit, authenticated re-encryption procedure rather than merely
changing the environment variable.

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
  -e SHARE_ENCRYPTION_KEY=<64-hex-characters> \
  -p 8080:8080 \
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

Creates the core users, auth-method, payment, share, deletion, and abuse-control
tables. The UMP support migration adds nullable `users.umpTokenOutpoint` plus
`phone_change_sessions` and `phone_change_history`. Back up the database before
rollout. Do not remove the history table after users begin changing numbers.

The `2026-09-18-001-faucet-payment-reservations` migration adds one durable
payment reservation per current user. It deliberately stops if pre-existing
duplicate non-null `payments.userId` rows exist; reconcile those financial
records rather than deleting one automatically. A ready payment may be returned
again to the same current account so a lost HTTP response does not destroy the
only R-puzzle secret. A concurrent or ambiguous first payout remains in
`creating` state and returns `503` until an operator reconciles that reservation;
the server never starts a second irreversible payout for it. An orphaned auth
identity whose preserved `receivedFaucet` flag has no payment on its newly linked
user remains ineligible for another payout. Unlink and account-deletion flows
detach rather than delete authentication rows and payment evidence so this
anti-abuse history survives account removal.

User-facing deletion responses disclose that account/share data is removed while
detached authentication identity and faucet-payment evidence is retained solely
to enforce the one-time faucet policy. Operators must document and disclose the
privacy and legal basis and retention period for that limited evidence, restrict
access to abuse-prevention purposes, and archive or delete it only when doing so
cannot reset a faucet claim.

The `2026-09-21-001-faucet-claim-backfill` migration marks every auth method
linked to a user with any persisted payment row. Only `ready` is deliverable;
every other status is a fail-closed pending claim. The migration stops on
**any** payment whose `userId` is already null: old data cannot prove which now-orphaned
identity rows shared that payment, and the absence of such a row can mean an old
unlink operation deleted it. Before retrying, an operator must back up the
database, correlate each orphaned payment from payment evidence, audit logs, and
backups, mark every formerly linked auth identity `receivedFaucet=true`, and
either restore the payment's correct user association or archive its evidence
under the incident record before removing the uncorrelatable active row. If the
identities cannot be reconstructed, conservatively mark every plausible
orphaned identity before archiving the payment. Never clear a faucet marker or
discard the only payment evidence merely to make the migration pass.

The faucet-claim migration requires a maintenance-window deployment and is not
safe as a mixed-version rolling upgrade. Remove the service from traffic, drain
and stop every old WAB replica, verify that no old writer remains, and take a
restorable backup before starting one new replica to apply the migration. Keep
traffic blocked until every replica uses the new image. Never run the old image
against the migrated database because its link/unlink paths can erase monotonic
claim evidence and reopen faucet reclaim. Roll forward, or restore the old image
and pre-migration database together while the service remains stopped.

Faucet recovery must cover both the database and the external wallet action.
Retain point-in-time database logs and protected wallet/audit evidence through
the latest faucet payment. After restoring a snapshot, keep the faucet endpoint
out of service until every later wallet action is correlated to its payment row
and authentication identities and the payment and `receivedFaucet` markers are
reconstructed. Where an identity association cannot be proved, conservatively
mark every plausible identity before re-enabling faucet traffic. A claim missing
from an older snapshot never authorizes another payout.

## Health checks

`GET /healthz` is the liveness endpoint and `GET /info` is the readiness and
configuration endpoint. Monitor:

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
- A WAB UMP pin is an ambiguity-only fallback and must match a wallet-verified lookup candidate
- Phone changes verify possession by OTP, stage current/pending keys across the UMP publish boundary, and clear a stale pin at finalization while recording reversible association history
- See how-it-works.md for detailed 2-of-3 cryptographic recovery explanation
- See [UMP account support](wab-ump-account-support.md) for the operator workflow

## Common pitfalls

- User identification by config, not presentation key: Auth method's buildConfigFromPayload() extracts unique identifier (e.g., phone number); two devices with same phone return same user's key
- Twilio setup critical: `TWILIO_VERIFY_SERVICE_SID` must be the canonical `VA` Verify Service SID. Partial or malformed Twilio configuration fails startup; with all three Twilio values absent the method is disabled and omitted from `/info`. WAB accepts only the service's exact 4–10 digit OTP and treats all non-approved provider states as the same authentication failure.
- SQLite for dev only: In-memory tables reset on restart; switch to MySQL for production
- Faucet requires funds: SERVER_PRIVATE_KEY wallet must have UTXOs; transactions fail if insufficient balance
- Dev console is ephemeral: its OTP store resets on restart and is intentionally unavailable in production/staging
- Public CORS is intentional for wallet apps on unknown domains; use `WAB_CORS_MODE=allowlist` only when the deployment has a closed caller set
- Migration timing: Must run before server startup; Knex handles schema versioning automatically
- Support token: `/admin/*` returns 404 when `WAB_ADMIN_TOKEN` is absent; a non-empty token shorter than 32 characters fails startup
- Phone takeover: proving possession of a number can transfer its WAB association; support must preserve and audit the returned `changeId` so a fraudulent transfer can be restored

## Source

- [GitHub](https://github.com/bsv-blockchain/ts-stack/tree/main/infra/wab)
- [npm package](https://npmjs.com/package/@bsv/wab-server)
