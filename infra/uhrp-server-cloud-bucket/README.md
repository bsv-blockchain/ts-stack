# UHRP Storage Server – Deployment Guide

See [Service Resource Profiles](../../docs/reference/service-resource-profiles.md)
for list, retention, response, connection, and provider-scaling guidance.

The service implements the BRC-167 CHIRP baseline routes under `/chirp/v1`.
CHIRP objects, sessions, and root leases use the `chirp/v1/` bucket namespace;
the ordinary `/cdn/*` backend-bucket rule remains unchanged because CHIRP
objects are served by Cloud Run with closure authorization. A root is submitted
to `tm_uhrp` only after its entire closure validates, `/renew` extends every
object's GCS `customTime`, and bounded GC preserves deduplicated objects while
any session or advertised root still references them. Existing UHRP APIs and
bucket object layouts remain compatible. Public object membership is served
from a bounded, expiring commit index rather than reparsing the full closure on
every request. Tune it with `CHIRP_COMMIT_CACHE_ROOTS`,
`CHIRP_COMMIT_CACHE_OBJECTS`, and `CHIRP_COMMIT_CACHE_SECONDS`.
Authenticated staging is bounded by atomic host-wide, per-identity,
per-session object, and per-session byte quotas. Commits for the same root are
serialized across instances through generation-guarded bucket locks. Tune the
limits with `CHIRP_MAX_ACTIVE_SESSIONS`,
`CHIRP_MAX_ACTIVE_SESSIONS_PER_IDENTITY`,
`CHIRP_MAX_STAGED_OBJECTS_PER_SESSION`, and
`CHIRP_MAX_STAGED_BYTES_PER_SESSION`; invalid or non-positive values fail
startup.

## Advertisement, ownership, and upload trust

The public UHRP token authenticates the host identity, content hash, HTTPS
location, expiry, size, and host-derived locking key. Uploader identity and the
GCS object identifier are not wire fields, so owner-only list, find, and renew
operations additionally require locally server-signed wallet metadata bound to
the exact token, BEEF output, and tags. Unsigned legacy metadata is not accepted
as ownership evidence. Re-advertise legacy objects with this release before
using private owner-management or renewal routes; their public UHRP availability
is not changed by this local migration.

Paid upload capabilities are valid for at most 15 minutes and never beyond the
purchased retention window. Their signatures bind the exact content length,
uploader metadata, safe binary response type, attachment disposition, and a
zero-generation precondition, preventing size substitution and URL replay to
overwrite an object. Billable renewal size is checked against both signed
advertisement metadata and current GCS metadata, and pricing errors fail closed.

This guide walks you through deploying **UHRP Storage Server** on Google Cloud Platform (GCP) with continuous delivery via GitHub Actions. When you finish, you’ll have:

- A single‑region **Cloud Storage bucket** that stores all UHRP data.

- A **Cloud Run** service that handles uploads, billing, and API requests.

- A **Cloud Run** service that handles the broadcasting and advertising of your UHRP data.

- An **HTTP Load Balancer** that fronts both the bucket (static files) and Cloud Run (dynamic API) behind a custom HTTPS domain.

- The protected root `infra-release.yaml` workflow that publishes immutable,
  scanned images for a separate operator-owned deployment process.

> **Security note** This imported deployment walkthrough is historical context,
> not authorization to grant project Owner or store service-account JSON keys.
> Current deployments must use a reviewed protected release workflow, GitHub
> OIDC/Google Workload Identity Federation, separate least-privilege
> deploy/runtime/notifier identities, and Secret Manager for application
> secrets. Do not place cloud credentials in repository secrets or generated
> service manifests.

---

## Prerequisites

**GCP Project with billing**
Create a new Project on Google Cloud Platform that you have owner or editor access and is funded

**GitHub account & repo**
You will fork/clone and push the code to your own repository.

**Domain name**
Optional but recommended for the HTTPS front‑end (e.g. `storage.example.com`).

**gcloud CLI**
Only required for the few shell commands shown below. Everything else uses the Cloud Console UI.

---

## 1 Use the TS Stack source repository

1.  **Fork or clone** the TS Stack repository:

    ```bash
    git clone https://github.com/bsv-blockchain/ts-stack.git
    cd ts-stack/infra/uhrp-server-cloud-bucket
    ```

2.  Review the root `.github/workflows/infra-release.yaml` image-release
    workflow and the operator-owned Cloud Run deployment configuration. The
    retired package-local setup/deploy workflows are intentionally absent.

---

## 2 Configure federated deployment and managed secrets

Before provisioning, create the Google Cloud project and a Workload Identity
Federation trust restricted to the protected repository/environment. Do not
create downloadable service-account keys.

### 2.1 Create a Google Cloud Project and deployment identities

1.  **Create a new GCP project**

    - Go to the [Google Cloud Console](https://console.cloud.google.com/).

    - In the top bar, click the **Project selector** → **New Project**.

    - Give your project a name (e.g., `uhrp-storage-server`)

    - Click **Create**.

2.  **Enable billing**

    - In the left menu, open **Billing**.

    - Link the project to an existing billing account (or create one if this is your first project).

    - Without this step, required APIs and services will not function.

3.  **Create separate keyless identities**

    - Bind the deployment identity through GitHub OIDC/Workload Identity
      Federation and restrict its principal set to the reviewed repository and
      protected deployment environment.
    - Grant only the Artifact Registry, Cloud Run deployment, and service
      account impersonation permissions used by the release workflow.
    - Give the runtime object access only to its one bucket plus
      `iam.serviceAccounts.signBlob` for short-lived signed upload URLs. Give
      the notifier read access only to finalized objects and permission to
      invoke the storage service.
    - Keep bootstrap administration outside CI and remove it after provisioning.

---

### 2.2 Prepare your environment file

1.  From the repo root, copy the example environment file:

    ```bash
    cp secrets/.env.example secrets/staging.env   # or prod.env for production
    ```

2.  Open the new file and fill in the required values for your environment.
    Refer to the inline comments in `.env.example` and update the fields as appropriate.

| Secret                                      | What it's for                                                                                            | Example                                      |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| **ADMIN_TOKEN**                             | Token required for communication between the storage-server service and the notifier service             | `super‑secret‑admin‑token`                   |
| **BSV_NETWORK**                             | Which Bitcoin SV network the server talks to                                                             | `mainnet`, `testnet`, or `ttn`/`teratestnet` |
| **GOOGLE_PROJECT_ID**                       | Your GCP project ID                                                                                      | `my‑gcp‑project`                             |
| **GCP_BUCKET_NAME**                         | The name for the Storage Bucket that will be created during setup                                        | `my-uhrp-bucket`                             |
| **GCR_HOST**                                | Hostname used within Google Cloud's Artifact Registry for your selected region                           | `us-west1-docker.pkg.dev`                    |
| **GCR_IMAGE_NAME**                          | Repository and image name (repo/image) for the Artifact Repository                                       | `uhrp/uhrp-storage`                          |
| **NODE_ENV**                                | Node environment string passed to the app                                                                | `staging` or `production`                    |
| **HOSTING_DOMAIN**                          | Public HTTPS domain for your load balancer. You will need access to register an A record for this domain | `storage.example.com`                        |
| **SERVER_PRIVATE_KEY**                      | 32‑byte hex private key used to sign on‑chain ops                                                        | `your-server-private-key`                    |
| **MIN_HOSTING_MINUTES**                     | Minimum expiration period for uploaded files                                                             | `15`                                         |
| **PRICE_PER_GB_MO**                         | Canonical positive-decimal monthly price (USD) per GB stored, up to `1000000`                            | `0.03`                                       |
| **WALLET_STORAGE_URL**                      | URL of the Toolbox Wallet storage server                                                                 | `https://staging-storage.babbage.systems`    |
| **HTTP_PORT**                               | Port your app listens on inside the container                                                            | `8080`                                       |
| **TRUST_PROXY_HOPS**                        | Optional trusted reverse-proxy hop count (0–10); omit for direct-socket IPs                              | `1`                                          |
| **UHRP_PRE_AUTH_RATE_LIMIT_MAX**            | Optional per-IP requests per pre-auth window (default 300/minute)                                        | `300`                                        |
| **UHRP_PRE_AUTH_RATE_LIMIT_WINDOW_MS**      | Optional pre-auth window in milliseconds                                                                 | `60000`                                      |
| **UHRP_AUTHENTICATED_RATE_LIMIT_MAX**       | Optional per-identity requests per authenticated window (default 1,000/minute)                           | `1000`                                       |
| **UHRP_AUTHENTICATED_RATE_LIMIT_WINDOW_MS** | Optional authenticated window in milliseconds                                                            | `60000`                                      |
| **CHIRP_MAX_ACTIVE_SESSIONS**               | Optional host-wide active CHIRP staging-session ceiling                                                  | `1024`                                       |
| **CHIRP_MAX_ACTIVE_SESSIONS_PER_IDENTITY**  | Optional active staging-session ceiling per authenticated identity                                       | `8`                                          |
| **CHIRP_MAX_STAGED_OBJECTS_PER_SESSION**    | Optional staged-object ceiling for one upload session                                                    | `4096`                                       |
| **CHIRP_MAX_STAGED_BYTES_PER_SESSION**      | Optional staged-byte ceiling for one upload session                                                      | `17179869184`                                |
| **DOCKERHUB_USERNAME**                      | _OPTIONAL_ Docker account username for GitHub Actions                                                    | `my-docker-username`                         |
| **DOCKERHUB_PASSWORD**                      | _OPTIONAL_ Docker account password                                                                       | `my-docker-password`                         |

> Cloud Run should use Application Default Credentials from its bound runtime
> service account. `GCP_STORAGE_CREDS`, `GCR_PUSH_KEY`, and `GCP_BOOTSTRAP_KEY`
> are legacy settings and must not be populated in Cloud Run or CI.

Invalid or unbounded rate-limit/proxy values fail startup. Forwarding headers
remain ignored unless `TRUST_PROXY_HOPS` is explicitly configured. The
in-memory store is per process; replicated deployments must enforce an
aggregate policy at their trusted ingress until a shared store is configured.

---

### 2.3 Configure settings and managed secrets

Put non-secret deployment settings in the protected environment. Store
`ADMIN_TOKEN`, `SERVER_PRIVATE_KEY`, and wallet credentials in Google Secret
Manager and mount/reference them at runtime. The legacy `sync-secrets` scripts
must not be used to upload long-lived Google credentials.

---

## 3 Provision through operator-owned infrastructure

The historical package-local `setup.yaml` workflow was retired because it used
broad static credentials. Provision these resources through reviewed,
operator-owned infrastructure as code:

1.  **Enable required APIs**
    All required GCP services (Cloud Run, Eventarc, Pub/Sub, Artifact Registry, etc.) are enabled automatically.

2.  **Create a Google Cloud Storage bucket**  
    A single-region bucket is created with **Autoclass enabled** and **soft-delete disabled**, using the name provided in your `.env` file.  
    It also applies the CORS configuration from `bucket-cors-config.json`.

3.  **Set up IAM accounts**

    - Grants Eventarc and Pub/Sub the project bindings they require.

    - Creates two service accounts:

      - **Deployer** (used by GitHub Actions to build & deploy).

      - **Runtime** (used by Cloud Run to access the bucket).

4.  **Create an Artifact Registry repository**  
    A regional Docker repository is created for your container images.

---

### 3.1 Run the reviewed provisioning workflow

Use the environment-specific operator workflow and verify its proposed IAM,
bucket, Eventarc, Artifact Registry, load-balancer, and Secret Manager changes
before applying. There is no supported package-local bootstrap action.

### 3.2 Verify keyless identities

After provisioning, verify that the deploy workflow exchanges GitHub's OIDC
token for a short-lived Google credential, the runtime uses its attached
service account through Application Default Credentials, and neither identity
has a user-managed key. Verify the runtime bucket and `signBlob` grants and the
notifier's bucket-read/invoker grants independently.

---

## 4 Understand release and deployment separation

The protected root `infra-release.yaml` workflow will build, scan, attest, sign,
and publish an immutable Linux/amd64 image. The separate operator deployment
must:

1.  Authenticate to GCP through the protected Workload Identity Federation
    provider and `GOOGLE_PROJECT_ID`; no JSON key is used.

2.  Select the verified image by digest rather than a mutable branch tag.

3.  Configure non-secret values and Secret Manager references without
    materializing secret values into a generated manifest.

4.  Deploy/replace the Cloud Run service in the bucket’s region.

5.  Deploy the notifier Cloud Run function on Node.js 24, matching its package
    runtime contract. The release sync includes its separate manifest and npm
    lockfile, so deploy the reviewed notifier source with the synchronized SDK
    floor. Its advertisement requests use `Authorization: Bearer <ADMIN_TOKEN>`;
    sending the token only in a JSON body is unsupported. Validate the notifier
    against the staging server before promoting the same source to production.

Source pushes do not implicitly authorize a Cloud Run deployment. Promotion is
an explicit operator-owned action against a verified image digest.

---

## 5 Validate the first deployment

1. Publish and verify the image through the protected root release workflow.
2. Promote the exact digest with the operator-owned deployment system.
3. Verify Cloud Run uses the intended runtime identity, Secret Manager refs,
   internal/load-balancer ingress policy, and zero user-managed service-account
   keys.
4. Exercise health/readiness, paid size-bound upload, public retrieval,
   owner-scoped list/find, renewal, advertisement, and notifier failure paths.

---

## 6 Create an HTTPS load balancer

### 6.1 Frontend configuration

| Setting         | Value                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------ |
| **Protocol**    | HTTPS                                                                                      |
| **IP version**  | IPv4                                                                                       |
| **IP address**  | **Create a new static IP** (e.g., `staging-uhrp-ingress-ip`)                               |
| **Port**        | 443                                                                                        |
| **Certificate** | **Create new → Google‑managed** (enter your `HOSTING_DOMAIN`, e.g., `storage.example.com`) |
| **Redirect**    | Enable **HTTP → HTTPS** redirect                                                           |

### 6.2 Backend configuration

#### 6.2.1 Backend Service → Cloud Run

| Field                                  | Value                                                                                          |
| -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Backend type**                       | Serverless network endpoint group (SNEG)                                                       |
| **Serverless network endpoint groups** | Create new                                                                                     |
| **Cloud Run region**                   | Same region as your bucket                                                                     |
| **Cloud Run service**                  | Select the service deployed by GitHub Actions (the main storage service, **not** the notifier) |
| **Cloud CDN**                          | **Disabled**                                                                                   |
| **Security policy**                    | **Default**                                                                                    |

Save to create the backend service (e.g., `uhrp-backend-service`).

#### 6.2.2 Backend **bucket** → Cloud Storage

| Field         | Value                          |
| ------------- | ------------------------------ |
| **Bucket**    | Your previously created bucket |
| **Cloud CDN** | **Enabled** (leave defaults)   |

### 6.3 Host & path rules

Add a rule that routes CDN requests to the bucket and everything else to Cloud Run:

| Host | Path     | Backend            |
| ---- | -------- | ------------------ |
| `*`  | `/cdn/*` | **Backend bucket** |

### 6.4 Create and test

Click **Create** and wait a few minutes. Then:

1.  Create an **A record** pointing your hosting domain to the load‑balancer IP (This may take a few hours).

2.  Wait for DNS propagation. The Google‑managed certificate will turn **Active** automatically.

3.  Test: Go to https://uhrp-ui.bapp.dev/ and test uploading and downloading with your hosting domain.

The service is ready for traffic only after the IAM, secret, upload-binding,
route, and failure-path checks above pass.

---

## 7 Next steps & hardening

- Restrict Cloud Run to accept traffic **only** from the load balancer’s identity instead of `allUsers`.

- Replace broad roles with narrower ones (e.g., Storage Object Viewer instead of Admin). Be sure to update the bucket IAM accordingly.

- Set up monitoring & alerts in **Cloud Monitoring**.

---

© 2025 – Feel free to adapt, improve, and PR!
