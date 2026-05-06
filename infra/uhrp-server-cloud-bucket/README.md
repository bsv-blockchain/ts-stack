# UHRP Storage Server – Deployment Guide

This guide walks you through deploying **UHRP Storage Server** on Google Cloud Platform (GCP) with continuous delivery via GitHub Actions. When you finish, you’ll have:

-   A single‑region **Cloud Storage bucket** that stores all UHRP data.
    
-   A **Cloud Run** service that handles uploads, billing, and API requests.

- A **Cloud Run** service that handles the broadcasting and advertising of your UHRP data.
    
-   An **HTTP Load Balancer** that fronts both the bucket (static files) and Cloud Run (dynamic API) behind a custom HTTPS domain.
    
-   A GitHub Actions workflow (`deploy.yaml`) that rebuilds and redeploys automatically whenever you push to the `master` or `production` branch.
    

> **Security note** The IAM roles in this tutorial are intentionally permissive to minimise friction. Feel free to tighten them once everything works.

----------

## Prerequisites

**GCP Project with billing**
Create a new Project on Google Cloud Platform that you have owner or editor access and is funded

**GitHub account & repo**
You will fork/clone and push the code to your own repository.

**Domain name**
Optional but recommended for the HTTPS front‑end (e.g. `storage.example.com`).

**gcloud CLI**
Only required for the few shell commands shown below. Everything else uses the Cloud Console UI.

----------

## 1 Get the code into your GitHub

1.  **Fork** the original repository or clone and push:
    
    ```bash
    git clone https://github.com/bitcoin-sv/storage-server.git
    cd storage-server
    git remote remove origin
    git remote add origin <your‑github‑repo‑url.git>
    git push origin master   # or production for your mainnet branch
    ```
    
2.  Verify that your repo contains `.github/workflows/deploy.yaml`. All future pushes to **`master`** or **`production`** will trigger this workflow.

----------

## 2 Add GitHub repository secrets

Before GCP resources can be provisioned, you must first create your Google Cloud Project, then create a temporary bootstrapping service account, and set up environment secrets in your GitHub repository.

### 2.1 Create a Google Cloud Project and bootstrap service account

1.  **Create a new GCP project**
    
    -   Go to the [Google Cloud Console](https://console.cloud.google.com/).

    -   In the top bar, click the **Project selector** → **New Project**.

    -   Give your project a name (e.g., `uhrp-storage-server`)

    -   Click **Create**.
        
2.  **Enable billing**
    
    -   In the left menu, open **Billing**.

    -   Link the project to an existing billing account (or create one if this is your first project).

    -   Without this step, required APIs and services will not function.
        
3.  **Create a temporary bootstrap service account**
    
    -   Go to **IAM & Admin > Service Accounts > Create**.

    -   Name it something like `uhrp-bootstrap`.

    -   Assign the **Owner** role.
        > This account is only used to seed your initial secrets. Delete it afterwards.
        
    - On the **Keys** tab, click **Add key → JSON** and download the key file.
        

----------

### 2.2 Prepare your environment file

1.  From the repo root, copy the example environment file:
    
    ```bash
    cp secrets/.env.example secrets/staging.env   # or prod.env for production
    ```
    
2.  Open the new file and fill in the required values for your environment.
Refer to the inline comments in `.env.example` and update the fields as appropriate.

| Secret | What it's for | Example |
| -- | -- | -- |
| **ADMIN_TOKEN** | Token required for communication between the storage-server service and the notifier service | `super‑secret‑admin‑token` |
| **BSV_NETWORK** | Which Bitcoin SV network the server talks to | `testnet` or `mainnet`|
| **GOOGLE_PROJECT_ID** | Your GCP project ID | `my‑gcp‑project` |
| **GCP_BUCKET_NAME** | The name for the Storage Bucket that will be created during setup | `my-uhrp-bucket` |
| **GCR_HOST** | Hostname used within Google Cloud's Artifact Registry for your selected region | `us-west1-docker.pkg.dev` |
| **GCR_IMAGE_NAME** | Repository and image name (repo/image) for the Artifact Repository | `uhrp/uhrp-storage` |
| **NODE_ENV** | Node environment string passed to the app | `staging` or `production` |
| **HOSTING_DOMAIN** | Public HTTPS domain for your load balancer. You will need access to register an A record for this domain | `storage.example.com` |
| **SERVER_PRIVATE_KEY** | 32‑byte hex private key used to sign on‑chain ops | `your-server-private-key` |
| **MIN_HOSTING_MINUTES** | Minimum expiration period for uploaded files | `15` |
| **PRICE_PER_GB_MO** | Monthly price (USD) for user per GB stored | `0.03` |
| **WALLET_STORAGE_URL** | URL of the Toolbox Wallet storage server | `https://staging-storage.babbage.systems` |
| **HTTP_PORT** | Port your app listens on inside the container | `8080` |
| **DOCKERHUB_USERNAME** | *OPTIONAL* Docker account username for GitHub Actions | `my-docker-username` |
| **DOCKERHUB_PASSWORD** | *OPTIONAL* Docker account password | `my-docker-password` |

> You don’t need to fill in `GCP_STORAGE_CREDS` or the `GCR_PUSH_KEY` yet. These will be generated later when you create Runtime and Deployer service accounts.

----------

### 2.3 Push secrets into GitHub

After setting the .env variables, run the sync-secrets script with your chosen environment.

```bash
npm run secrets:staging   # or npm run secrets:prod
```

This will read `staging.env` or `prod.env` and push the values into your GitHub Actions secrets automatically.

----------

### 2.4 Verify secrets

Go to **GitHub → Settings → Secrets and variables → Actions** and confirm that all variables from your env file are now present under your repository.

----------

### 2.5 Add the bootstrap key manually

In addition to syncing secrets from your `.env` file, you must also add the **bootstrap service account key** to your repository manually:

1.  Open the JSON file you downloaded when creating the bootstrap service account.
    
2.  Copy the **entire file contents** (including `{` and `}`) into your clipboard.
    
3.  Go to **GitHub → Settings → Secrets and variables → Actions → New repository secret**.
    
4.  Name the secret `GCP_BOOTSTRAP_KEY`
        
5.  Paste the raw JSON string as the value and click **Save**.

----------

## 3 Understand the GitHub setup workflow

The **Setup GCP** workflow (`.github/workflows/setup.yaml`) automates the initial provisioning of Google Cloud resources. When triggered, it performs the following:

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
    
----------

### 3.1 Run the Setup GCP workflow

Finally, go to **GitHub → Actions → Setup GCP**, choose your **environment** (`staging` or `prod`) and specify the **region** (e.g., `us-west1`).

When the workflow completes successfully, your project will have all required GCP resources and secrets in place. You can now proceed to deploy the server normally.

### 3.2 Generate keys and update your env file

After the workflow finishes:

1.  Go to **IAM & Admin > Service Accounts**, select both the **Deployer** and **Runtime** accounts, and generate a **JSON key** for each.
    
2.  Paste the raw JSON for each into your env file:
    
| Secret | What it's for | Example |
| -- | -- | -- |
| **GCP_STORAGE_CREDS** | JSON Key for the **Runtime** service account that Cloud Run uses to access the bucket | `{ "type": "service_account", ... "compute@developer.gserviceaccount.com" ... }` |
| **GCR_PUSH_KEY** | JSON Key for the **Deployer** service account that is used by GitHub Action to deploy the project | `{ "type": "service_account", ... "iam.gserviceaccount.com" ... }` |

3.  Re-run the secrets sync for your environment:
    
    ```bash
    npm run secrets:staging # or npm run secrets:prod
    ```
4. The bootstrap service account is no longer needed. Remove it from both the Google Cloud Project IAM Service Accounts list and the GitHub Repository Secrets list.

----------


## 4 Understand the GitHub Actions workflow

`deploy.yaml` will:

1.  Authenticate to GCP using `GCR_PUSH_KEY` and `GOOGLE_PROJECT_ID`.
    
2.  Build & push the Docker image `<GCR_HOST>/<PROJECT>/<IMAGE_NAME>:branch‑sha`.
    
3.  Generate a `service.<branch>.yaml` manifest with all environment variables.
    
4.  Deploy/replace the Cloud Run service in the bucket’s region.
    
5.  Deploy the notifier Cloud Run service.
    

Every push to the **`master`** branch triggers the staging deployment. A push to **`production`** does the same but reads only the production secrets.

----------

## 5 Trigger the first deployment

1.  Commit any change and push to `master` or `production`.
    
2.  Watch **GitHub > Actions** → _Deployment_ run. Green check = success.
    
3.  In GCP **Cloud Run > Services**, verify a new service appears in your chosen region. Click its URL to confirm the server responds.
    
----------

## 6 Create an HTTPS load balancer

### 6.1 Frontend configuration

| Setting | Value |
| -- | -- |
| **Protocol** | HTTPS |
| **IP version** | IPv4 |
| **IP address** | **Create a new static IP** (e.g., `staging-uhrp-ingress-ip`)|
| **Port** | 443 | 
| **Certificate** | **Create new → Google‑managed** (enter your `HOSTING_DOMAIN`, e.g., `storage.example.com`) |
| **Redirect** | Enable **HTTP → HTTPS** redirect |

### 6.2 Backend configuration

#### 6.2.1 Backend Service → Cloud Run
| Field | Value |
| -- | -- |
| **Backend type** | Serverless network endpoint group (SNEG) |
| **Serverless network endpoint groups** | Create new |
| **Cloud Run region** | Same region as your bucket |
| **Cloud Run service** | Select the service deployed by GitHub Actions (the main storage service, **not** the notifier) |
| **Cloud CDN** | **Disabled** |
| **Security policy** | **Default** |

Save to create the backend service (e.g., `uhrp-backend-service`).

#### 6.2.2 Backend **bucket** → Cloud Storage
| Field | Value |
| -- | -- |
| **Bucket** | Your previously created bucket  |
| **Cloud CDN** | **Enabled** (leave defaults) |

### 6.3 Host & path rules

Add a rule that routes CDN requests to the bucket and everything else to Cloud Run:

| Host | Path | Backend
| -- | -- | -- |
| `*` | `/cdn/*` | **Backend bucket** |

### 6.4 Create and test

Click **Create** and wait a few minutes. Then:

1.  Create an **A record** pointing your hosting domain to the load‑balancer IP (This may take a few hours).
    
2.  Wait for DNS propagation. The Google‑managed certificate will turn **Active** automatically.
    
3.  Test: Go to https://uhrp-ui.bapp.dev/ and test uploading and downloading with your hosting domain. 

Everything is now live, secure, and fronted by a global HTTPS load balancer.

----------

## 7 Next steps & hardening

-   Restrict Cloud Run to accept traffic **only** from the load balancer’s identity instead of `allUsers`.
    
-   Replace broad roles with narrower ones (e.g., Storage Object Viewer instead of Admin). Be sure to update the bucket IAM accordingly.
        
-   Set up monitoring & alerts in **Cloud Monitoring**.
    
----------

© 2025 – Feel free to adapt, improve, and PR!
