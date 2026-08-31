---
id: infra-uhrp-cloud
title: 'UHRP Server (Cloud Bucket)'
kind: infra
version: '0.2.36'
last_updated: '2026-08-26'
last_verified: '2026-08-26'
review_cadence_days: 30
status: stable
tags: [uhrp, storage, cloud, google-cloud-run, production]
---

# UHRP Server (Cloud Bucket)

> A production-grade UHRP host server backed by Google Cloud Storage. Stores large files in cloud buckets with optional billing/micropayments and includes advertising infrastructure for overlay network discovery.

The 0.2.36 image refreshes its Alpine OpenSSL runtime libraries to 3.5.8-r0
to remediate CVE-2026-14456. Service APIs, bucket layouts, CHIRP behavior, and
deployment configuration are unchanged from 0.2.35.

## What it does

A TypeScript/Express server designed for Google Cloud Run that implements UHRP
workflows backed by Google Cloud Storage. Static object retrieval is public;
upload, list, find, and renewal require BRC-103 identity. A separate
administrative advertisement endpoint uses a strong Bearer token.

Clients request authenticated uploads, retrieve files via public GET, and use
the bucket notifier to trigger authenticated hosting advertisements.

## When to deploy this

- Production UHRP hosting on Google Cloud Run or equivalent
- High-volume file storage with auto-scaling requirements
- Multi-region replication and disaster recovery needed
- Monetizing UHRP hosting via micropayments
- Advertising UHRP services to overlay network

## Dependencies

| Type              | Requirement                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Database          | None; Google Cloud Storage is the object and metadata source of truth                                                    |
| External services | Google Cloud Storage bucket, ARC API key, Wallet Storage, Bugsnag (optional)                                             |
| ts-stack packages | @bsv/sdk, @bsv/auth-express-middleware, @bsv/payment-express-middleware, @bsv/wallet-toolbox, @bsv/wallet-toolbox-client |

## HTTP endpoints

| Method   | Path                | Purpose                                                    |
| -------- | ------------------- | ---------------------------------------------------------- |
| GET/HEAD | Static object paths | Retrieve stored objects (public)                           |
| POST     | /advertise          | Administrative advertisement using `Authorization: Bearer` |
| POST     | /quote              | Public storage-price quote                                 |
| POST     | /upload             | Authenticated upload/payment workflow                      |
| GET      | /list               | List the authenticated uploader's objects                  |
| GET      | /find               | Find authenticated uploader metadata                       |
| POST     | /renew              | Authenticated ownership/payment renewal                    |
| GET      | /health, /healthz   | Public process liveness                                    |
| GET      | /ready              | Public initialization readiness                            |

## WebSocket endpoints

None; HTTP-only with background advertising worker.

## Configuration (env vars)

| Variable                       | Required | Description                                                                              |
| ------------------------------ | -------- | ---------------------------------------------------------------------------------------- |
| HTTP_PORT                      | No       | Express server port (default: 8080, typically 8080 for Cloud Run)                        |
| NODE_ENV                       | No       | `development`, `staging`, or `production`                                                |
| SERVER_PRIVATE_KEY             | Yes      | 256-bit hex private key for server identity                                              |
| HOSTING_DOMAIN                 | No       | Public HTTPS domain for advertising (e.g., `https://uhrp-storage.example.com`)           |
| BSV_NETWORK                    | No       | `mainnet`, `testnet`, `ttn`, or `teratestnet` (default `mainnet`)                    |
| WALLET_STORAGE_URL             | No       | Wallet storage endpoint (e.g., `https://store-us-1.bsvb.tech`)                           |
| PRICE_PER_GB_MO                | No       | Monthly storage price per GB for billing                                                 |
| MIN_HOSTING_MINUTES            | No       | Minimum requested retention period (default 180 minutes)                                 |
| GCP_PROJECT_ID                 | Yes*     | GCP project used for production signed upload URLs                                       |
| GCP_BUCKET_NAME                | Yes      | Cloud Storage bucket name (e.g., `uhrp-storage-prod`)                                    |
| GCP_STORAGE_CREDS              | Yes*     | JSON credentials used for production signed upload URLs; provide through a secret        |
| ADMIN_TOKEN                    | Yes      | At least 32 random characters for `/advertise` Bearer auth                               |
| UHRP_CORS_MODE                 | No       | `public` (default), `allowlist`, or `disabled`                                           |
| UHRP_CORS_ALLOWED_ORIGINS      | No       | Exact comma-separated origins in allowlist mode                                          |
| UHRP_CORS_ALLOWED_HEADERS      | No       | Strict comma-separated browser request-header allowlist; omit for additive compatibility |
| UHRP_JSON_MAX_BODY_BYTES       | No       | JSON body ceiling (default 262144)                                                       |
| TRUST_PROXY_HOPS               | No       | Exact trusted proxy hop count, 0 through 10                                              |

`GCP_PROJECT_ID` and `GCP_STORAGE_CREDS` are required by the production
signed-upload path; the development path returns a local placeholder URL.

See [Public Service Edge Security](service-edge-security.md#uhrp-cloud-bucket-server)
for full edge controls.

## Run locally

```bash
# Install dependencies
npm install

# Development with hot-reload
npm run dev

# Build TypeScript
npm run build

# Run production build
npm start
```

Requires GCP service account credentials or emulator for local testing.

## Deploy to production

```bash
# Multi-stage build: pinned Node 24 alpine builder → production runtime
docker build -t uhrp-storage:latest .

# Deploy to Google Cloud Run
gcloud run deploy uhrp-storage \
  --image uhrp-storage:latest \
  --platform managed \
  --region us-central1 \
  --set-env-vars SERVER_PRIVATE_KEY=<hex-key>,GCP_PROJECT_ID=<project>,GCP_BUCKET_NAME=uhrp-storage-prod,ADMIN_TOKEN=<32+-character-token>

# Or deploy with docker-compose (local testing only)
docker compose up -d
```

Follows GCP 12-factor patterns: stateless design, cloud bucket for file storage, Cloud SQL for optional metadata, Cloud Logging integration, Bugsnag for error tracking. Graceful shutdown via SIGTERM signal handling.

## Migrations

No database migrations. Google Cloud Storage is the durable source of truth.

## Health checks

- `GET /health` and `GET /healthz` report process liveness.
- `GET /ready` returns 200 only after wallet-backed authentication and payment
  middleware initialization completes; the container health check uses it.

## Spec conformance

- **UHRP** – Implements UHRP host protocol for file storage, retrieval, and metadata
- **BRC-103** – Mutual authentication on upload, list, find, and renewal workflows
- **BRC-100** – Payment verification for uploads (optional)
- **Google Cloud** – Follows Cloud Run best practices (health checks, graceful shutdown, 12-factor)

## Integration with ts-stack

- UHRP clients upload/retrieve files using SERVER_PRIVATE_KEY and HOSTING_DOMAIN
- Wallet Storage derives keys, validates payments, manages user accounts
- The bucket notifier calls the token-protected `/advertise` route, which
  publishes the UHRP advertisement through the SDK SHIP broadcaster

## Common pitfalls

- GCP credentials: GOOGLE_APPLICATION_CREDENTIALS must point to valid service account JSON; Cloud Run uses default service account if not set
- Storage bucket policy: Ensure bucket exists and service account has storage.objects.create/get/delete permissions
- Cost management: Monitor storage usage and pricing; use Cloud Storage lifecycle policies for archival
- Signed uploads: `GCP_PROJECT_ID`, `GCP_BUCKET_NAME`, and valid JSON in
  `GCP_STORAGE_CREDS` must agree; malformed credentials fail URL creation
- Advertising: `ADMIN_TOKEN` must match the bucket notifier and contain at
  least 32 characters
- Cloud Run and application request timeouts default to 60 seconds; use direct cloud upload workflows for large objects rather than unbounded application buffering
- Graceful shutdown: Cloud Run sends SIGTERM; ensure all writes complete before exit (transaction broadcasts, metadata flushes)

## Source

- [GitHub](https://github.com/bsv-blockchain/ts-stack/tree/main/infra/uhrp-server-cloud-bucket)
- [npm package](https://npmjs.com/package/@bsv/uhrp-storage-server)
