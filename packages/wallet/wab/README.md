# Wallet Authentication Backend (WAB)

Welcome to the **Wallet Authentication Backend (WAB)** project! This README provides a **comprehensive, ground-up guide** to help you **understand**, **configure**, **deploy**, and **run** your own WAB server. 

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

- **Node.js 18+** (or 16+ should also work, but 18+ recommended for built-in Web Crypto).
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
    client: "sqlite3",
    connection: { filename: "./dev.sqlite3" },
    useNullAsDefault: true,
    migrations: {
      directory: path.resolve(__dirname, "src/db/migrations")
    }
  },
  // ...
};
```

### Environment Variables

For local development, you can create a `.env` file in the `server/` root with the following variables:

```bash
# .env

# Twilio config (if you want to test the Twilio method locally)
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxx
TWILIO_VERIFY_SERVICE_SID=VExxxxxxxxx

# If using a local MySQL or other DB, for example:
DB_CLIENT=pg
DB_USER=mysql
DB_PASS=password
DB_NAME=wallet_auth
DB_HOST=localhost
DB_PORT=5432

# Other environment-specific config
PORT=3000
```

*(Note: The server already reads environment variables to figure out how to connect to the DB, Twilio, etc. Adjust as needed.)*

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

The WAB is **modular**: you can configure multiple ways for users to authenticate. Two example methods are:

1. **Twilio Phone Verification** (SMS-based).
2. **Persona / Jumio ID Verification** (3rd-party ID check).

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

We also have a `PersonaAuthMethod` example. This is **mocked** for demonstration. If you want real ID verification, integrate with **Persona** or **Jumio** properly (webhooks, tokens, verifying session IDs, etc.).

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
DB_CLIENT=pg
DB_CONNECTION_NAME=my-project:us-central1:wab-sql
DB_USER=myuser
DB_PASS=mysecret
DB_NAME=mydatabase
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxx
TWILIO_VERIFY_SERVICE_SID=VExxxxxxxxx
PORT=8080
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
  --set-env-vars=DB_CLIENT=pg \
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

This project is available under the [Open BSV License v4](./LICENSE.txt).
