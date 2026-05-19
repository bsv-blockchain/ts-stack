# CLAUDE.md — UHRP Storage Server (Cloud Bucket)

## Purpose
A production-grade UHRP host server backed by Google Cloud Storage (or S3-compatible buckets). Stores large files in cloud buckets, provides HTTP endpoints for UHRP data retrieval and storage with billing/micropayments, and includes advertising infrastructure. Designed for high-volume deployments on Google Cloud Run with Cloud SQL.

## Service surface
- **PUT /put/{hash}** – Upload file to cloud bucket (authenticated, priced, size-limited)
- **GET /{hash}** – Retrieve file from cloud bucket (public)
- **POST /lookup** – UHRP metadata lookup queries (public)
- **GET /info** – Server info, pricing, and status (public)
- **Advertising** – Background worker broadcasts UHRP host advertisement to overlay network
- **Health/readiness** – Implicit health via /info endpoint

## Real deployment
- **Dockerfile** – Multi-stage: Node 22 alpine builder → production runtime with ts-node
- **No docker-compose.yml** – Designed for Google Cloud Run + Cloud SQL, not Docker Compose
- **No nginx.conf** – Cloud Run handles HTTP/2, load balancing, and SSL
- **Cloud Storage** – Google Cloud Storage bucket via `@google-cloud/storage` SDK
- **Optional backup storage** – Supports multiple storage providers (local fallback, MySQL blob storage)
- **No migrations** – Stateless; cloud bucket is the source of truth

## Configuration
Environment variables:
- **HTTP_PORT** – Express server port (default: 8080, typically 8080 for Cloud Run)
- **NODE_ENV** – `development`, `staging`, or `production`
- **SERVER_PRIVATE_KEY** – 256-bit hex private key for server identity (required)
- **HOSTING_DOMAIN** – Public HTTPS domain for advertising (e.g., `https://uhrp-storage.example.com`)
- **BSV_NETWORK** – Target blockchain network (`main`, `test`, or `regtest`)
- **WALLET_STORAGE_URL** – Wallet storage endpoint (e.g., `https://storage.babbage.systems`)
- **PRICE_PER_GB_MO** – Monthly storage price per GB for billing
- **ENABLE_PAYMENT_MIDDLEWARE** – Set to `'true'` to require payment for uploads
- **GOOGLE_CLOUD_PROJECT** – GCP project ID (auto-detected from service account if available)
- **GOOGLE_CLOUD_BUCKET** – Cloud Storage bucket name (e.g., `uhrp-storage-prod`)
- **GOOGLE_APPLICATION_CREDENTIALS** – Path to service account JSON key (for local/Cloud Run auth)
- **ARC_API_KEY** – ARC API key for transaction broadcasting (advertising)
- **ADVERTISE_INTERVAL_MS** – Interval for re-advertising to overlay (default: 3600000ms = 1 hour)
- **BUGSNAG_API_KEY** – Bugsnag error reporting API key (optional)

## Dependencies
- **Database** – Optional MySQL via Knex (for backup storage or metadata tracking); not required if using cloud-only
- **@bsv packages**
  - `@bsv/sdk` – Cryptography, key operations, transaction signing
  - `@bsv/auth-express-middleware` – Request/response authentication for PUT
  - `@bsv/payment-express-middleware` – Price calculation and payment verification
  - `@bsv/wallet-toolbox` – Wallet operations, key derivation
  - `@bsv/wallet-toolbox-client` – Wallet client interface
- **Cloud infrastructure**
  - Google Cloud Storage – File storage via `@google-cloud/storage`
  - Google Cloud Logging – Via Bunyan integration (optional)
  - Google Cloud IAM – Service account authentication
- **External services**
  - Wallet Storage (via `WALLET_STORAGE_URL`) – Key derivation, payment validation
  - ARC – Transaction broadcaster for advertising transactions
  - Overlay network – Advertises UHRP host capability
- **Error tracking** – Bugsnag via `@bugsnag/js` and `@bugsnag/plugin-express` (optional)
- **Key packages** – Express, body-parser, dotenv, axios, semver

## Operational concerns
- **Deployment** – Designed for **Google Cloud Run** with Cloud SQL backing; follows GCP's 12-factor patterns
- **Local dev** – `npm run dev` with nodemon, requires GCP service account credentials or emulator
- **Production** – `npm run build && npm start` or via Cloud Run container with gcloud deploy
- **Scaling** – Cloud Run auto-scales; stateless design (files in cloud bucket, session data optional)
- **Storage** – Google Cloud Storage; cost based on actual usage + configured PRICE_PER_GB_MO
- **Payment** – Optional micropayment enforcement via payment middleware; transactions broadcast via ARC
- **Secrets** – Use Google Secret Manager or Cloud Run environment variables for sensitive values
- **Monitoring** – Bugsnag for error tracking, Cloud Logging for audit/access logs
- **Backups** – Cloud Storage handles durability; consider multi-region bucket configuration

## Spec conformance
- **UHRP** – Implements UHRP host protocol for file storage, retrieval, and metadata
- **BRC-103** – Mutual authentication on PUT, optional on GET/POST
- **BRC-100** – Payment verification for uploads (optional)
- **Google Cloud** – Follows Cloud Run best practices (health checks, graceful shutdown, 12-factor)

## Integration points
- **UHRP clients** – Any UHRP-aware client uploads/retrieves files using SERVER_PRIVATE_KEY and HOSTING_DOMAIN
- **Wallet Storage** – Derives keys, validates payments, manages user accounts
- **Overlay network** – Background worker advertises UHRP host via SHIP overlay protocol
- **ARC** – Broadcasts advertising and payment transactions to BSV network
- **Google Cloud ecosystem** – Secret Manager, Cloud SQL, Cloud Logging, Cloud Monitoring

## File map
- **src/**
  - `index.ts` – Entry point: Express app, cloud storage init, advertising loop, graceful shutdown
  - `routes/` – HTTP handlers: PUT (upload), GET (download), POST (lookup), GET /info
  - `utils/` – Helpers: file pricing, wallet singleton, metadata, bucket operations, error handling
  - `config/` – Storage provider abstraction (Google Cloud, MySQL fallback, local filesystem)
- **scripts/**
  - `sync-secrets.ts` – Cloud Secret Manager sync to .env (staging/prod)
  - `verify-config.ts` – Pre-deployment config validation
- **Dockerfile** – Multi-stage Node 22 alpine builder → production
- **package.json** – Scripts: `dev`, `build`, `start`, `secrets:staging`, `secrets:prod`
- **.env.example** – Template with GCP, wallet, and storage config
- **README.md** – Deployment guide for Google Cloud Run setup
