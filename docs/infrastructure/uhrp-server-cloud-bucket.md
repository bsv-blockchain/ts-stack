---
id: infra-uhrp-cloud
title: "UHRP Server (Cloud Bucket)"
kind: infra
version: "0.2.1"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
status: stable
tags: [uhrp, storage, cloud, google-cloud-run, production]
---

# UHRP Server (Cloud Bucket)

> A production-grade UHRP host server backed by Google Cloud Storage (or S3-compatible buckets). Stores large files in cloud buckets with optional billing/micropayments and includes advertising infrastructure for overlay network discovery.

## What it does

A TypeScript/Express server designed for Google Cloud Run that implements UHRP endpoints backed by Google Cloud Storage or S3-compatible buckets. Files are uploaded via authenticated PUT /put/{hash} endpoint with BRC-103 signatures, served publicly via GET /{hash}, and queried via POST /lookup. The server bills users per GB/month using configurable pricing, optionally enforces micropayment verification, and runs a background worker that broadcasts UHRP host advertisements to the overlay network via SHIP protocol. Metadata tracked in optional Cloud SQL MySQL database; stateless HTTP service with cloud bucket as source of truth.

Clients upload files with authentication, retrieve files via public GET, and server continuously advertises hosting capability.

## When to deploy this

- Production UHRP hosting on Google Cloud Run or equivalent
- High-volume file storage with auto-scaling requirements
- Multi-region replication and disaster recovery needed
- Monetizing UHRP hosting via micropayments
- Advertising UHRP services to overlay network

## Dependencies

| Type | Requirement |
|------|-------------|
| Database | Optional MySQL via Knex (for backup storage or metadata tracking); not required if using cloud-only |
| External services | Google Cloud Storage bucket, ARC API key, Wallet Storage, Bugsnag (optional) |
| ts-stack packages | @bsv/sdk, @bsv/auth-express-middleware, @bsv/payment-express-middleware, @bsv/wallet-toolbox, @bsv/wallet-toolbox-client |

## HTTP endpoints

| Method | Path | Purpose |
|--------|------|---------|
| PUT | /put/{hash} | Upload file to cloud bucket (authenticated, priced, size-limited) |
| GET | /{hash} | Retrieve file from cloud bucket (public) |
| POST | /lookup | UHRP metadata lookup queries (public) |
| GET | /info | Server info, pricing, and status (public) |

## WebSocket endpoints

None; HTTP-only with background advertising worker.

## Configuration (env vars)

| Variable | Required | Description |
|----------|----------|-------------|
| HTTP_PORT | No | Express server port (default: 8080, typically 8080 for Cloud Run) |
| NODE_ENV | No | `development`, `staging`, or `production` |
| SERVER_PRIVATE_KEY | Yes | 256-bit hex private key for server identity |
| HOSTING_DOMAIN | No | Public HTTPS domain for advertising (e.g., `https://uhrp-storage.example.com`) |
| BSV_NETWORK | No | Target blockchain network (`main`, `test`, or `regtest`) |
| WALLET_STORAGE_URL | No | Wallet storage endpoint (e.g., `https://store-us-1.bsvb.tech`) |
| PRICE_PER_GB_MO | No | Monthly storage price per GB for billing |
| ENABLE_PAYMENT_MIDDLEWARE | No | Set to `'true'` to require payment for uploads |
| GOOGLE_CLOUD_PROJECT | No | GCP project ID (auto-detected from service account if available) |
| GOOGLE_CLOUD_BUCKET | Yes | Cloud Storage bucket name (e.g., `uhrp-storage-prod`) |
| GOOGLE_APPLICATION_CREDENTIALS | No | Path to service account JSON key (for local/Cloud Run auth) |
| ARC_API_KEY | No | ARC API key for transaction broadcasting (advertising) |
| ADVERTISE_INTERVAL_MS | No | Interval for re-advertising to overlay (default: 3600000ms = 1 hour) |
| BUGSNAG_API_KEY | No | Bugsnag error reporting API key (optional) |

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
# Multi-stage build: Node 22 alpine builder → production runtime
docker build -t uhrp-storage:latest .

# Deploy to Google Cloud Run
gcloud run deploy uhrp-storage \
  --image uhrp-storage:latest \
  --platform managed \
  --region us-central1 \
  --set-env-vars SERVER_PRIVATE_KEY=<hex-key>,GOOGLE_CLOUD_BUCKET=uhrp-storage-prod,ENABLE_PAYMENT_MIDDLEWARE=true

# Or deploy with docker-compose (local testing only)
docker compose up -d
```

Follows GCP 12-factor patterns: stateless design, cloud bucket for file storage, Cloud SQL for optional metadata, Cloud Logging integration, Bugsnag for error tracking. Graceful shutdown via SIGTERM signal handling.

## Migrations

Stateless; cloud bucket is source of truth. Optional MySQL Knex migrations for metadata tables if ENABLE_METADATA_DB=true.

## Health checks

Implicit health via /info endpoint (HTTP 200). Cloud Run readiness probe typically checks GET /info or GET /{hash} availability. No explicit /healthz endpoint.

## Spec conformance

- **UHRP** – Implements UHRP host protocol for file storage, retrieval, and metadata
- **BRC-103** – Mutual authentication on PUT, optional on GET/POST
- **BRC-100** – Payment verification for uploads (optional)
- **Google Cloud** – Follows Cloud Run best practices (health checks, graceful shutdown, 12-factor)

## Integration with ts-stack

- UHRP clients upload/retrieve files using SERVER_PRIVATE_KEY and HOSTING_DOMAIN
- Wallet Storage derives keys, validates payments, manages user accounts
- Background worker advertises UHRP host via SHIP overlay protocol using ARC broadcaster
- Optional Cloud SQL metadata database for query optimization
- Bugsnag integration for production error tracking and monitoring

## Common pitfalls

- GCP credentials: GOOGLE_APPLICATION_CREDENTIALS must point to valid service account JSON; Cloud Run uses default service account if not set
- Storage bucket policy: Ensure bucket exists and service account has storage.objects.create/get/delete permissions
- Cost management: Monitor storage usage and pricing; use Cloud Storage lifecycle policies for archival
- Payment enforcement: ENABLE_PAYMENT_MIDDLEWARE requires ARC_API_KEY and WALLET_STORAGE_URL; uploads fail if not configured
- Advertising loop: ADVERTISE_INTERVAL_MS should balance frequent updates vs transaction costs; 1 hour is conservative default
- Cloud Run timeout: Default 60s timeout may be too short for large file uploads; increase if needed
- Graceful shutdown: Cloud Run sends SIGTERM; ensure all writes complete before exit (transaction broadcasts, metadata flushes)

## Source

- [GitHub](https://github.com/bsv-blockchain/uhrp-server-cloud-bucket)
- [npm package](https://npmjs.com/package/@bsv/uhrp-storage-server)
