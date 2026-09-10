# Wallet Authentication Backend (WAB)

Welcome to the **Wallet Authentication Backend (WAB)** project! This README provides a **comprehensive, ground-up guide** to help you **understand**, **configure**, **deploy**, and **run** your own WAB server.

See [Service Resource Profiles](../../docs/reference/service-resource-profiles.md)
for bounded defaults, database sizing, and HPA prerequisites.

---

## What Is the WAB?

The **Wallet Authentication Backend (WAB)** is a Node.js/Express server built in **TypeScript** that provides a **modular, extensible** system for **multi-factor** user authentication. It manages **256-bit presentation keys** for users, which can be used to authenticate/authorize actions elsewhere (e.g., in a wallet or other system).

Each user’s presentation key is **guarded** by one or more **Auth Methods** (e.g., Twilio SMS, government ID verification). Once a user completes an Auth Method, the WAB either:

- **Creates** a new record (if they’re a new user), storing their 256-bit key securely, or
- **Retrieves** an existing key (if they’re returning).

Additionally, the WAB provides a **faucet** feature that can make a one-time BSV satoshi payment for each unique presentation key, logging the payment and returning the transaction data to the user.

---

## How the 2 of 3 Recovery System Works

[Details](./how-it-works.md) on how the system actually works under the hood. Only the presentation key recovery happens via WAB, but the context might help some understand the purpose of this server.

---

## Features & Capabilities

1. **Extensible Auth Methods** – Offers a generic interface to link multiple authentication methods to the same key.
2. **Multi-Factor** – Users can link multiple methods, each requiring verification for future access to the same key.
3. **Faucet** – One-time or recurring (customizable) faucet payment logic for new accounts.
4. **Knex-based Database** – Uses migrations for reliable schema updates (supports MySQL or SQLite).
5. **TypeScript** – Strict typing, improved developer experience.
6. **Docker** – Containerized for easy deployment.
7. **CI/CD** – Example GitHub Actions workflow to build, push, and deploy to **Google Cloud Run** with **Cloud SQL**.
8. **UMP support pinning** – An authenticated operator can select one UMP outpoint as a legacy-ambiguity fallback.
9. **Verified phone changes** – Authenticated wallets can verify the same or a new number, rotate their presentation key, and retain reversible ownership history.
10. **Optional presentation-key vault** – A staged, rolling-upgrade-compatible mode can AES-256-GCM encrypt presentation keys at rest and index them with a keyed lookup digest without changing the client API.
11. **Recoverable registration** – New identities remain pending until the wallet confirms its UMP token was published, so interrupted account creation can resume safely.

---

## Repository Structure

A typical layout for the WAB server might look like this:

```
server/
├── package.json
├── tsconfig.json
├── jest.config.ts
├── knexfile.ts
├── Dockerfile
├── .dockerignore
├── .github
│   └── workflows
│       └── deploy.yaml
├── src
│   ├── app.ts
│   ├── server.ts
│   ├── db
│   │   ├── knex.ts
│   │   └── migrations
│   │       └── 202302130000_init.ts
│   ├── authMethods
│   │   ├── AuthMethod.ts
│   │   ├── TwilioAuthMethod.ts
│   │   ├── PersonaAuthMethod.ts
│   │   └── ...
│   ├── controllers
│   │   ├── InfoController.ts
│   │   ├── AuthController.ts
│   │   ├── UserController.ts
│   │   └── FaucetController.ts
│   ├── services
│   │   └── UserService.ts
│   ├── types
│   │   └── index.ts
│   └── utils
│       └── generateRandomKey.ts
└── tests
    ├── authMethods.test.ts
    ├── controllers.test.ts
    └── services.test.ts
```

---

## Local Development Setup

### Prerequisites

- **Node.js 24** and npm 11 (the supported runtime declared in `package.json`).
- **npm** or **yarn** package manager.
- **SQLite** (for quick local dev) or a local MySQL database if you prefer.

> **Note**: You can also run it in Docker locally. If so, ensure you have **Docker** installed.

### Installation Steps

1. **Clone the repository**:

   ```bash
   git clone https://github.com/your-org/wab-server.git
   cd wab-server
   ```

2. **Install dependencies**:

   ```bash
   npm install
   ```

   or

   ```bash
   yarn
   ```

3. **Build** (to compile TypeScript → JavaScript):
   ```bash
   npm run build
   ```
   or
   ```bash
   yarn build
   ```

### Database Configuration

By default, in **development**, the [`knexfile.ts`](./knexfile.ts) is configured to use **SQLite**. This is perfect for quick local testing. If you want to use MySQL locally, update the `development` section of the `knexfile.ts`.

```ts
// Example (knexfile.ts snippet):
const config: { [key: string]: Knex.Config } = {
  development: {
    client: 'sqlite3',
    connection: { filename: './dev.sqlite3' },
    useNullAsDefault: true,
    migrations: {
      directory: path.resolve(__dirname, 'src/db/migrations')
    }
  }
  // ...
}
```

### Environment Variables

For local development, you can create a `.env` file in the `server/` root with the following variables:

```bash
# .env

# Twilio config (if you want to test the Twilio method locally)
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxx
TWILIO_VERIFY_SERVICE_SID=VExxxxxxxxx

# If using a local MySQL database:
DB_CLIENT=mysql2
DB_USER=mysql
DB_PASS=password
DB_NAME=wallet_auth
DB_HOST=localhost
DB_PORT=3306

# Other environment-specific config
PORT=3000

# Optional presentation-key defense in depth. Omit both for legacy mode.
# Read "Staged presentation-key encryption" before changing an existing server.
WAB_PRESENTATION_KEY_ENCRYPTION_MODE=dual-write
WAB_PRESENTATION_KEY_ENCRYPTION_KEY=<64 hex characters from a secret manager>

# Optional, explicit reverse-proxy hop count. Omit when directly reachable.
TRUST_PROXY_HOPS=1

# Public CORS is the default. For a closed caller set:
# WAB_CORS_MODE=allowlist
# WAB_CORS_ALLOWED_ORIGINS=https://wallet.example.com
# Omit WAB_CORS_ALLOWED_HEADERS for forward-compatible preflights, or set an
# exact comma-separated browser request-header allowlist.

# Console OTP is permitted only in development/test and requires both values.
# NODE_ENV=development
# DEV_CONSOLE_AUTH_METHOD_ENABLED=true

# Optional support capability. Use at least 32 random characters and source it
# from the deployment secret manager. If omitted, admin routes return 404.
# WAB_ADMIN_TOKEN=
```

_(Note: The server already reads environment variables to figure out how to connect to the DB, Twilio, etc. Adjust as needed.)_

### Staged presentation-key encryption

WAB must be able to return a presentation key after successful authentication;
the server and its runtime encryption key therefore remain inside the trusted
boundary. This feature is defense in depth against a database-only disclosure,
not protection from a fully compromised WAB process. The HTTP API and key values
returned to legacy clients do not change in any mode.

The schema migration only adds nullable sidecar columns. It never rewrites an
existing row, does not require an encryption key, and can be applied while the
old WAB version is still serving traffic. Roll out the feature in three stages:

1. Deploy the additive schema/new binary in `legacy` mode (the default when no
   vault key is configured). Existing plaintext reads and writes continue.
2. Generate a separate 32-byte random key, keep it in the deployment secret
   manager, and use `dual-write`. Startup idempotently backfills keyed lookup
   digests and AES-256-GCM ciphertext while retaining plaintext for old
   replicas. When the mode variable is omitted, configuring a valid key also
   selects `dual-write`.
3. After every old replica is drained and a dual-write startup has completed,
   explicitly switch every replica to `encrypted`. Startup reconciles any final
   legacy writes and redacts the plaintext columns before accepting traffic.

Do not start an old binary after stage 3. Returning from `encrypted` to a prior
binary requires first restoring plaintext with a controlled rollback using the
same vault key. Back up the vault key separately from the database; losing it
after redaction makes those account credentials unrecoverable. A malformed key
always fails startup, and `dual-write`/`encrypted` refuse to start without one.

All state-changing routes are rate-limited and return HTTP 429 with
`ERR_RATE_LIMITED`. Defaults are 10 authentication attempts per 15 minutes,
120 user operations per 15 minutes, 5 faucet requests per hour, 5 account
deletion attempts per 15 minutes, and 10 share operations per 15 minutes.
Override a policy with `<PREFIX>_MAX` and `<PREFIX>_WINDOW_MS`, where the
prefix is `WAB_AUTH_RATE_LIMIT`, `WAB_USER_RATE_LIMIT`,
`WAB_FAUCET_RATE_LIMIT`, `WAB_ACCOUNT_DELETION_RATE_LIMIT`, or
`WAB_SHARE_RATE_LIMIT`. Administrative support routes use
`WAB_ADMIN_RATE_LIMIT` (30 requests per 15 minutes by default). Invalid or
unbounded values fail startup.

Express ignores forwarding headers unless `TRUST_PROXY_HOPS` is explicitly set
to a value from 0 through 10. Set it only to the number of trusted proxies in
front of the service; never expose an instance configured for a proxy directly
to untrusted clients.

WAB is a public protocol service used by deployed wallet apps on many domains.
It therefore enables wildcard CORS without cookie credentials by default.
`WAB_CORS_MODE=allowlist` plus exact origins, or `disabled`, provides an
operator opt-in restriction. Authentication and all endpoint rate limits apply
in every mode. This API policy is independent of Content Security Policy:
deploying applications should configure CSP for their own documents, while WAB
uses authentication, authorization, validation, and rate limits to protect API
operations.

### Authentication and account-deletion invariants

Phone identities use canonical E.164 form. Ordinary sign-in and linking do not
move a phone identity between live users. The authenticated phone-change flow
is the deliberate exception: after the target wallet proves its current
presentation key and possession of the claimed phone by OTP, the WAB moves the
phone record, stages and then finalizes the target presentation key, clears any
obsolete UMP pin at finalization, and writes the previous owners/associations
to `phone_change_history`.
Support can restore those associations if the change is later determined to be
fraudulent. Faucet history remains attached to its original auth-method record.
Presentation keys and Shamir user hashes are exact 256-bit hexadecimal values.
Stored Shamir shares are bounded and structurally validated before any database
operation.

Account deletion is a two-step proof-of-identity flow. The start response is
identical for known and unknown identities to avoid account enumeration. Its
bearer token has 256 bits of entropy; only a SHA-256 digest is persisted. The
intent expires after ten minutes, is single-use, is rate-limited per external
identity, and is bound to the authentication method, canonical identity, and
specific live user. A valid OTP from another flow or account cannot authorize
deletion.

### UMP pin and phone-change support

`POST /auth/complete` remains backward compatible and may add
`umpTokenOutpoint` when support has pinned that WAB account. Updated wallet
clients still run normal verified UMP lookup and lineage selection first. They
use the pin only if the result remains ambiguous and the pin names one of the
verified candidates.

New registrations use a two-phase lifecycle. OTP completion atomically creates
and links the WAB identity with `registrationStatus: "pending"`. The wallet
publishes its UMP token and then calls `/auth/registration/finalize`; retries
reuse the same WAB presentation key. If publication succeeded but the finalize
response was interrupted, the next verified login finds the token and
finalizes idempotently. Existing rows migrate as `active`, so a missing UMP
token never makes an established account silently replaceable.

Phone changes use four calls: `/auth/phone-change/start`,
`/auth/phone-change/complete`, `/auth/phone-change/commit`, and
`/auth/phone-change/finalize`. The first two prove possession of the requested
number. Commit consumes the hashed, ten-minute, single-use authorization and
stages the phone association plus replacement presentation key while retaining
the current key. After the wallet publishes the UMP update, finalize promotes
the staged key and clears the obsolete pin. During an interrupted transition,
`/auth/complete` adds the pending key and change ID so an updated wallet can
select the key backed by the verified UMP token and finish idempotently. If the
current key remains live, repeating the phone-change OTP returns the staged key
and change ID instead of creating a second authorization/commit. Entering the
current number is valid and intentionally refreshes the key/hash.

Operator routes require `Authorization: Bearer <WAB_ADMIN_TOKEN>`, are
rate-limited, and return 404 when no strong token is configured:

A non-empty token shorter than 32 characters is a startup configuration error;
only an absent/empty value intentionally disables the routes.

- `POST /admin/ump-pin` sets or clears a pin after identifying a user by
  presentation key or authentication method payload.
- `POST /admin/registration/reopen` performs a verified UMP lookup, then marks a
  support-verified, pre-migration stranded registration pending only when the
  lookup is cleanly empty, without deleting its identity or faucet history.
- `POST /admin/phone-change/restore` restores the associations recorded for a
  `changeId`; it refuses automatic restoration after another ownership change.

Follow [UMP account support](../../docs/infrastructure/wab-ump-account-support.md)
for evidence requirements, commands, auditing, rollout, and rollback.

### Running Locally

1. **Run migrations** (to create or update the DB schema):
   ```bash
   npm run migrate
   ```
2. **Start the server in dev mode**:

   ```bash
   npm run dev
   ```

   or

   ```bash
   yarn dev
   ```

   This runs `ts-node-dev` or equivalent.

   The server should start on `http://localhost:3000`.

3. **Test** the endpoints:
   ```bash
   curl http://localhost:3000/info
   ```
   You should see a JSON response with the WAB’s config info.

---

## Auth Methods

### Admin-managed demonstration accounts

WAB 1.6 adds opt-in `DemoPhone` accounts for app-store reviewers and other
shared demonstrations. They use a separate identity namespace: an identical
phone-shaped alias under `TwilioPhone` continues to require real SMS verification
and resolves to a different wallet. Demo codes never authenticate an ordinary
SMS identity or authorize a phone-number transfer.

Set a dedicated, secret-manager-provided `WAB_DEMO_AUTH_SECRET` of at least 32 random
characters, and the existing `WAB_ADMIN_TOKEN`, to provision demo access through
`POST /admin/demo-accounts`. The JSON `action` is one of:

- `provision`: supply `phoneNumber` (an E.164-shaped demo alias), `label`, and
  `expiresAtEpochMs` within the next 30 days, or explicit JSON `null` for
  non-expiring store-review access (WAB 1.7+). Omitted expiry and numeric zero
  are rejected. Returns a random six-digit `code`
  once, plus the account `id`. The alias is not proof of telephone ownership.
- `rotate`: supply `id` and `expiresAtEpochMs`; returns a new code once and
  restores the account's five-attempt budget. The demo identity remains the same.
- `revoke`: supply `id`; disables subsequent demo authentication immediately.
- `list`: returns metadata for the latest 100 demo accounts, never codes or hashes.

All management actions require the existing administrator bearer credential and
rate limits. Provision/rotation responses are `Cache-Control: no-store`. Codes
are stored only as keyed digests, bound to the account's random identifier. An
account locks after five incorrect codes in total until an administrator rotates
it; this budget is database-backed across replicas and does not reset on sign-in,
restart, or a new authentication start. Expired/revoked accounts fail closed.
Removing the demo key disables the method; rotating that key invalidates all
existing demo codes until each account's code is rotated.

Use an expiry for temporary demonstrations. Stores that require permanently
reusable reviewer credentials can use explicit `null`; all admin authentication,
guess-budget, secret-rotation and revocation controls still apply. Keep a named
operator responsible for revoking this access when it is no longer needed.
Changing between expiring and non-expiring modes requires an admin code rotation.
The non-expiring mode persists zero in the existing expiry column; an older WAB
binary treats it as expired, so rollback fails closed without a schema change.

Clients can select `DemoPhone` explicitly, or configure the WAB base URL as
`https://your-wab.example/demo`. The latter advertises only `DemoPhone` so existing
clients that select the first advertised method work without a new binary.
Use the alias on the phone screen, the administrator-provided code on the OTP
screen, and a separate wallet password. No SMS is sent for this method.
For compatibility with older mobile phone interactors, requests to the explicit
`/demo` base URL translate the wire method `TwilioPhone` to `DemoPhone` before
authentication. They never resolve a real SMS identity. Ordinary root routes do
not perform this translation. Phone-number change is not supported on the demo
base URL; normal authentication, recovery shares and account deletion are.

Ordinary WAB discovery keeps `TwilioPhone` first. The `/demo` routes share normal
authentication, user-operation, and faucet rate limits.

Initialize the dedicated demo wallet and verify a second clean sign-in before
sharing its credentials with reviewers. Never reuse a personal or customer
wallet; shared demo wallets should contain only disposable demonstration data
and a deliberately limited sample balance. Revocation stops WAB sign-in, but
cannot erase wallet keys or snapshots already shared with a reviewer. Keep a
record of the operator, purpose, account id, expiry, and revocation. Do not log
codes, wallet passwords, presentation keys, or administrative credentials.

The migration adds only `demo_accounts`; existing identities require no
migration. Retain the table when rolling back to an older image, which ignores
it. Disable demo access and update reviewer instructions before rollback.

The WAB is **modular**: you can configure multiple ways for users to authenticate. Two example methods are:

1. **Twilio Phone Verification** (SMS-based).
2. **Development console OTP** (explicit development/test opt-in only).

### Configuring Twilio Phone Verification

**Twilio** is a popular service for sending SMS verification codes. Here’s how to enable it:

1. **Sign up** for a [Twilio account](https://www.twilio.com/).
2. **Create** or **access** a [Verify Service](https://www.twilio.com/console/verify/services). Copy the **Service SID** (looks like `VAxxxxxxxxx` or `VExxxxxxx`).
3. In your Twilio console, **grab**:
   - **Twilio Account SID** (`ACxxxxxxxxx...`)
   - **Auth Token**
4. **Store** them in your environment variables:
   ```bash
   TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxx
   TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxx
   TWILIO_VERIFY_SERVICE_SID=VExxxxxxxxx
   ```
5. **Use** the `TwilioAuthMethod` in code. By default, the [AuthController](./src/controllers/AuthController.ts) can instantiate it if `methodType === "TwilioPhone"`.

When a client sends a request to `/auth/start` with `methodType = "TwilioPhone"`, the server calls Twilio to send the SMS code. The client then calls `/auth/complete` with the OTP code, and the WAB verifies it with Twilio, linking that phone number to the user’s presentation key.

> **Note**: For more advanced Twilio features (voice calls, push notifications, etc.), you can customize the `TwilioAuthMethod`.

### Persona / Jumio ID Verification (Example)

The repository contains a mocked `PersonaAuthMethod` example, but it is not
registered or advertised by the server. It must not be treated as production
identity verification without a complete provider integration and review.

### Adding More Methods

To add a new method, simply create a class that extends `AuthMethod`. Implement:

- `startAuth(...)`
- `completeAuth(...)`
- `buildConfigFromPayload(...)`
- (Optional) `isAlreadyLinked(...)`

Then **register** or **instantiate** it within your `AuthController` (or a helper) to handle different `methodType` strings.

---

## Deployment Guide (Google Cloud)

This guide uses **Google Cloud** services:

- **Google Cloud Run** for serverless container hosting.
- **Google Container Registry (GCR)** for container images.
- **Cloud SQL** for database hosting (MySQL).
- **GitHub Actions** for CI/CD with **Workload Identity Federation** (WIF).

### High-Level Architecture

1. **CI/CD**: On push to GitHub, GitHub Actions:
   - Builds Docker image → pushes to GCR.
   - Deploys the new image to Cloud Run.
2. **Database**: Cloud Run connects to Cloud SQL over a secure private connection via the **Cloud SQL Auth Proxy**.

### Cloud SQL Database Setup

1. Create a **Cloud SQL** instance (MySQL).
2. Make note of your instance name (e.g., `my-project:us-central1:wab-sql`), username, and password.
3. (Optional) Enable a **private IP** if you want a fully private connection. Otherwise, Cloud Run can connect with `--add-cloudsql-instances`.

### GitHub Actions & Workload Identity Federation

1. Create a **Google Cloud service account** with roles:
   - `roles/run.admin` (Cloud Run Admin)
   - `roles/storage.admin` or `roles/storage.objectAdmin` for GCR
   - `roles/cloudsql.admin` or `roles/cloudsql.client`
2. Configure **Workload Identity Federation** so GitHub can obtain short-lived credentials without storing a key file. Follow [Google’s official docs](https://github.com/google-github-actions/auth/blob/main/docs/workload-identity-federation.md).
3. Create a GitHub OIDC provider in your GCP project, link your repository.
4. Store the resource names (like `GCP_WORKLOAD_IDENTITY_PROVIDER`) and service account email (like `my-wab-deployer@my-project.iam.gserviceaccount.com`) in **GitHub Secrets**.

### Docker Image & Container Registry

1. Check the [Dockerfile](./Dockerfile) in the `server/` folder. It uses a multi-stage build to keep images small.
2. **Build** locally if you want to test:
   ```bash
   docker build -t gcr.io/<PROJECT_ID>/wab-server:local-test .
   ```
3. **Push** manually (optional test):
   ```bash
   docker push gcr.io/<PROJECT_ID>/wab-server:local-test
   ```

### Deploying to Cloud Run

We provide a [GitHub Actions workflow](./.github/workflows/deploy.yaml) that automates:

- **Build & push** to GCR.
- **Deploy** to Cloud Run, specifying environment variables.

**Key environment variables** for production might be:

```bash
NODE_ENV=production
DB_CLIENT=mysql2
DB_CONNECTION_NAME=my-project:us-central1:wab-sql
DB_USER=myuser
DB_PASS=mysecret
DB_NAME=mydatabase
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxx
TWILIO_VERIFY_SERVICE_SID=VExxxxxxxxx
PORT=8080
# Optional; begin with dual-write during a rolling upgrade.
WAB_PRESENTATION_KEY_ENCRYPTION_MODE=dual-write
WAB_PRESENTATION_KEY_ENCRYPTION_KEY=<64 hex characters from a secret manager>
```

You configure these either in **GitHub Secrets** or in the Cloud Run deploy command (`--set-env-vars`).

**Example** `gcloud run deploy` command (if deploying manually):

```bash
gcloud run deploy wab-server-production \
  --image gcr.io/my-project/wab-server:some-tag \
  --region us-central1 \
  --platform managed \
  --allow-unauthenticated \
  --add-cloudsql-instances=my-project:us-central1:wab-sql \
  --set-env-vars=NODE_ENV=production \
  --set-env-vars=DB_CLIENT=mysql2 \
  --set-env-vars=DB_CONNECTION_NAME=my-project:us-central1:wab-sql \
  --set-env-vars=DB_USER=myuser \
  --set-env-vars=DB_PASS=mysecret \
  --set-env-vars=DB_NAME=mydatabase \
  --set-env-vars=TWILIO_ACCOUNT_SID=ACxxxxxxx \
  --set-env-vars=TWILIO_AUTH_TOKEN=xxxxxxx \
  --set-env-vars=TWILIO_VERIFY_SERVICE_SID=VExxxxxxx \
  --set-env-vars=PORT=8080
```

> The workflow in `.github/workflows/deploy.yaml` automates these steps on pushes to specific branches (e.g. `master` for staging, `production` for prod) using **Workload Identity Federation**.

### Post-Deployment Checks

- Go to **Cloud Run** in GCP console. Confirm your service is running.
- Check **Logs** to see if any errors occurred.
- **Test** your endpoint: `curl https://<your-cloud-run-url>/info`.
- If you used domain mapping, confirm your custom domain is pointing properly.

---

## Troubleshooting & FAQ

1. **Database connection refused**:
   - Ensure the `DB_CONNECTION_NAME` in environment variables matches your Cloud SQL instance name.
   - Confirm you used `--add-cloudsql-instances=<instance-connection-name>`.
   - Check IAM permissions for your Cloud Run service account (it needs `Cloud SQL Client` role).

2. **Twilio: “Invalid service SID”**:
   - Double-check you used the correct `TWILIO_VERIFY_SERVICE_SID`.
   - Make sure the Twilio service is active and has an SMS channel.

3. **401 or 403 on GitHub Actions**:
   - Confirm your WIF provider is correctly set up.
   - Verify the `service account` has the correct roles.

4. **Knex migrations** failing on Cloud Run:
   - If your container runs migrations on startup, ensure your DB user has `CREATE TABLE` / `ALTER TABLE` privileges.
   - Alternatively, run migrations from a separate pipeline or step before deployment, so your production container can remain read-only.

5. **Performance issues**:
   - You may need to scale your Cloud Run service or upgrade your Cloud SQL tier.
   - Consider caching or adding a load balancer in front if you have high throughput usage.

---

## Contributing

We welcome contributions! Feel free to open **pull requests** or **issues** if you have improvements, bug reports, or new Auth Methods to share.

To contribute:

1. Fork the repo.
2. Create a feature branch.
3. Make changes & add tests.
4. Open a PR for review.

---

## License

This project is available under the [Open BSV License Version 6](./LICENSE.txt).
