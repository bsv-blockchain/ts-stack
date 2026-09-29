---
id: infra-uhrp-cloud
title: 'UHRP Server (Cloud Bucket)'
kind: infra
version: '0.2.49'
last_updated: '2026-09-27'
last_verified: '2026-09-27'
review_cadence_days: 30
status: stable
tags: [uhrp, storage, cloud, google-cloud-run, production]
---

# UHRP Server (Cloud Bucket)

> A production-grade UHRP host server backed by Google Cloud Storage. Stores large files in cloud buckets with optional billing/micropayments and includes advertising infrastructure for overlay network discovery.

The 0.2.49 source candidate fixes CHIRP renewal pricing by reading the verified
root from `chirp/v1/objects/<root>` rather than looking for a duplicate CDN copy.
Ordinary advertisements retain their `cdn/<object>` path. Signed ownership,
provider size checks, pricing, and renewal behavior remain unchanged. No object,
advertisement, wallet, or lease migration is required. Publication and deployment
remain separate operator actions through the protected image workflow.

## What it does

A TypeScript/Express server designed for Google Cloud Run that implements UHRP
workflows backed by Google Cloud Storage. Static object retrieval is public;
upload, list, find, and renewal require BRC-103 identity. A separate
administrative advertisement endpoint uses a strong Bearer token.

Clients request authenticated uploads, retrieve files via public GET, and use
the bucket notifier to trigger authenticated hosting advertisements.

The on-chain token authenticates host, hash, HTTPS location, expiry, and size;
uploader ownership and the GCS object name are intentionally local metadata,
not wire fields. Private owner routes require a server-signed metadata envelope
bound to the exact wallet/BEEF output and current GCS size. Unsigned legacy
rows are omitted from owner-management results and counted per page in
`legacyAdvertisementsPending`; clients continue with `nextOffset`. Recover
valid active legacy objects using the dry-run-first operator command documented
in the [service README](https://github.com/bsv-blockchain/ts-stack/blob/main/infra/uhrp-server-cloud-bucket/README.md#recover-legacy-ownership-without-replacing-transactions).
It verifies provider ownership and streamed content against the host-signed
token, then merges signed metadata into the existing wallet output without
spending or rebroadcasting. Invalid or changed records require private review.
Public UHRP lookup and retrieval remain wire-compatible.

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

| Variable                  | Required | Description                                                                              |
| ------------------------- | -------- | ---------------------------------------------------------------------------------------- |
| HTTP_PORT                 | No       | Express server port (default: 8080, typically 8080 for Cloud Run)                        |
| NODE_ENV                  | No       | `development`, `staging`, or `production`                                                |
| SERVER_PRIVATE_KEY        | Yes      | 256-bit hex private key for server identity                                              |
| HOSTING_DOMAIN            | No       | Public HTTPS domain for advertising (e.g., `https://uhrp-storage.example.com`)           |
| BSV_NETWORK               | No       | `mainnet`, `testnet`, `ttn`, or `teratestnet` (default `mainnet`)                        |
| WALLET_STORAGE_URL        | No       | Wallet storage endpoint (e.g., `https://store-us-1.bsvb.tech`)                           |
| PRICE_PER_GB_MO           | No       | Canonical positive-decimal monthly USD price per GB (maximum `1000000`)                  |
| MIN_HOSTING_MINUTES       | No       | Minimum requested retention period (default 180 minutes)                                 |
| GCP_PROJECT_ID            | Yes*     | GCP project used for production signed upload URLs                                       |
| GCP_BUCKET_NAME           | Yes      | Cloud Storage bucket name (e.g., `uhrp-storage-prod`)                                    |
| GCP_STORAGE_CREDS         | No       | Legacy local-only JSON credentials; omit in Cloud Run and use its runtime identity       |
| ADMIN_TOKEN               | Yes      | At least 32 random characters for `/advertise` Bearer auth                               |
| UHRP_CORS_MODE            | No       | `public` (default), `allowlist`, or `disabled`                                           |
| UHRP_CORS_ALLOWED_ORIGINS | No       | Exact comma-separated origins in allowlist mode                                          |
| UHRP_CORS_ALLOWED_HEADERS | No       | Strict comma-separated browser request-header allowlist; omit for additive compatibility |
| UHRP_JSON_MAX_BODY_BYTES  | No       | JSON body ceiling (default 262144)                                                       |
| TRUST_PROXY_HOPS          | No       | Exact trusted proxy hop count, 0 through 10                                              |

The external exchange-rate lookup rejects redirects, has a ten-second absolute
deadline and a 64 KiB response ceiling, and accepts only a bounded positive
rate. Transport, payload, or plausibility failure uses the local fallback rate,
so the rate provider cannot indefinitely stall pricing or force an unboundedly
low quote.

`GCP_PROJECT_ID` is required by the production signed-upload path. Cloud Run
uses Application Default Credentials from its attached least-privilege runtime
service account, including `iam.serviceAccounts.signBlob`; do not create or
embed a user-managed JSON key. The development path returns a local placeholder
URL.

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

Use an emulator or a deliberately isolated local Application Default
Credentials profile for local testing. Never commit or synchronize that
credential.

## Deploy to production

The protected root `infra-release.yaml` workflow builds and publishes the
immutable Linux/amd64 image. Deploy that digest through the operator-owned
Cloud Run configuration. Authenticate CI with repository/environment-scoped
GitHub OIDC and Google Workload Identity Federation; attach distinct
least-privilege deployer, runtime, and notifier service accounts. Reference
`SERVER_PRIVATE_KEY`, `ADMIN_TOKEN`, and wallet credentials from Secret Manager
rather than placing their values in CLI arguments or generated manifests.

`docker compose up -d` is for local testing only.

Follows GCP 12-factor patterns: stateless design, cloud bucket for file storage, Cloud SQL for optional metadata, Cloud Logging integration, Bugsnag for error tracking. Graceful shutdown via SIGTERM signal handling.

## Migrations

No database migration is required. Google Cloud Storage is the durable source
of truth. Existing unsigned UHRP wallet metadata remains usable for public
retrieval but must be re-advertised once to acquire server-authenticated owner
metadata before list, find, or renew.

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

- GCP credentials: Cloud Run must use its attached runtime identity and
  Application Default Credentials; user-managed JSON keys are legacy
  local-only compatibility
- Storage bucket policy: scope object permissions to the one service bucket;
  add only the runtime `signBlob` permission required for signed writes
- Cost management: Monitor storage usage and pricing; use Cloud Storage lifecycle policies for archival
- Signed uploads: capabilities are create-only, bind paid Content-Length and
  safe attachment metadata, expire within 15 minutes and the paid retention
  window, and require clients to send every returned `requiredHeaders` entry
- Advertising: `ADMIN_TOKEN` must match the bucket notifier and contain at
  least 32 characters
- Cloud Run and application request timeouts default to 60 seconds; use direct cloud upload workflows for large objects rather than unbounded application buffering
- Graceful shutdown: Cloud Run sends SIGTERM; ensure all writes complete before exit (transaction broadcasts, metadata flushes)

## Source

- [GitHub](https://github.com/bsv-blockchain/ts-stack/tree/main/infra/uhrp-server-cloud-bucket)
- [npm package](https://npmjs.com/package/@bsv/uhrp-storage-server)
