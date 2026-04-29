# Deploying Wallet-Infra to Google Cloud Run

For production or cloud usage, we recommend deploying the Docker container to Google Cloud Run. This guide walks you through:

1. Creating a new (or using an existing) Cloud SQL for MySQL instance
2. Setting up a dedicated user and database
3. Building and pushing your Docker image
4. Deploying to Cloud Run
5. Verifying everything works end-to-end

--- 

### Prerequisites

1. **Google Cloud CLI** (`gcloud`) – installed and authenticated to your GCP project (`gcloud auth login`).
2. **Cloud Run** enabled in your GCP project. 
3. **Docker** – for building the container image locally (you can also use GitHub Actions to build it).

## 1. Prepare the Dockerfile

This repository includes a sample Dockerfile:

```dockerfile
FROM node:20-alpine

# Install nginx (optional)
RUN apk add --no-cache --update nginx && \
    chown -R nginx:www-data /var/lib/nginx

COPY ./nginx.conf /etc/nginx/nginx.conf
EXPOSE 8080

WORKDIR /app
COPY . .
RUN npm i knex -g && \
    npm run build

# By default, node out/src/index.js. It will conditionally run Nginx if NODE_ENV != development
CMD [ "node", "out/src/index.js"]
```

Note: If you prefer to skip Nginx in production, you can remove the `RUN apk add ...` line and any references to `nginx`. By default, `index.ts` spawns Nginx only if `NODE_ENV !== 'development'`.

---

## 2. Create or Use a Cloud SQL Instance


If you **already have** a MySQL instance set up, skip to [Step 3](#3-create-the-wallet_storage-database).

Otherwise, create a new instance:

```bash
gcloud sql instances create my-wallet-sql-instance \
  --database-version=MYSQL_8_0 \
  --tier=db-f1-micro \
  --region=us-west1 \
  --authorized-networks=0.0.0.0/0
```

Configuring `authorized-networks` like this allows all traffic by default. (This may not be recommended for production, so adjust accordingly.)

Adjust parameters (machine type, region) as needed. Then set a root password:

```bash
gcloud sql users set-password root \
  --host=% \
  --instance=my-wallet-sql-instance \
  --password=YOUR_SECURE_PASSWORD
```
---

## 3. Create the `wallet_storage` Database

Once your MySQL instance is up, create your primary database. You can do this with one of the following:

### Cloud SQL Command-Line

```bash
gcloud sql connect my-wallet-sql-instance --user=root
```

When prompted, enter your root password. Then in the MySQL shell:

```sql
CREATE DATABASE wallet_storage;
SHOW DATABASES; -- optional, to verify it exists
```

### A MySQL Client (Workbench, CLI, etc.)

- Connect to your Cloud SQL instance (or local instance) using host, port, and credentials.  
- Run `CREATE DATABASE wallet_storage;`.

---

## 4. Create a Dedicated User (Optional)

For better security, create and grant privileges to a **non-root** user (e.g., `wallet_admin`).

1. **Create a user** (outside the MySQL shell):
   ```bash
   gcloud sql users create wallet_admin \
     --instance=my-wallet-sql-instance \
     --password=ANOTHER_SECURE_PASSWORD
   ```

2. **Grant privileges** on the `wallet_storage` database. First connect with root:
   ```bash
   gcloud sql connect my-wallet-sql-instance --user=root
   ```
   Then in the MySQL shell:
   ```sql
   GRANT ALL PRIVILEGES ON wallet_storage.* TO 'wallet_admin'@'%';
   FLUSH PRIVILEGES;
   EXIT;
   ```

3. **Use `wallet_admin`** in your connection settings rather than `root`, e.g.:

   ```jsonc
   {
     "host": "PUBLIC_IP_OR_SOCKET_PATH_OF_YOUR_INSTANCE",
     "user": "wallet_admin",
     "password": "ANOTHER_SECURE_PASSWORD",
     "database": "wallet_storage",
     "port": 3306
   }
   ```

---

## 5. Test Your DB Connection String

Verify you can connect to your MySQL instance using the credentials you plan to provide to Cloud Run:

- **Public IP**: If using a public IP for Cloud SQL, ensure any required network settings (firewall rules, SSL, etc.) are in place.  
- **Private IP** or **Sockets**: If using private IP or Unix sockets, read [Cloud SQL + Cloud Run docs](https://cloud.google.com/sql/docs/mysql/connect-run) for the correct `host` or `socketPath` syntax.

Example valid JSON for an environment variable:

```json
{
  "host": "PUBLIC_IP_OF_YOUR_INSTANCE",
  "user": "wallet_admin",
  "password": "ANOTHER_SECURE_PASSWORD",
  "database": "wallet_storage",
  "port": 3306
}
```

If you can connect via a local MySQL client (such as MySQLWorkbench) using these credentials, you should be good to go.

## 6. Build Your Docker Image

**Install and build local dependencies** (the Dockerfile will copy over node_modules):
   ```bash
   npm install
   npm run build
   ```

From your project’s root folder:

```bash
docker build --platform linux/amd64 -t gcr.io/PROJECT_ID/utxo-management-server:latest .
```

Replace `PROJECT_ID` with your actual Google Cloud project ID.

If you are unsure what your `PROJECT_ID` is, you can use the following command to list the available projects:

```bash
gcloud projects list
```

---

## 7. Push Your Image to Container Registry

```bash
docker push gcr.io/PROJECT_ID/utxo-management-server:latest
```

---

## 8. Deploy to Cloud Run

Before deploying, create an env.yaml file in your local directory to store environment variables:

```yaml
NODE_ENV: "production"
BSV_NETWORK: "main" # main | test
ENABLE_NGINX: "true"
HTTP_PORT: "8080"
SERVER_PRIVATE_KEY: "<PRIVATE_KEY_HEX_STRING>"
KNEX_DB_CONNECTION: '{"host": "<HOST>", "user": "wallet_admin", "password": "<ANOTHER_SECURE_PASS>", "database": "wallet_storage", "port": 3306}'
```
Update the example environment values as needed. 

You may also want to include `env.yaml` in your .gitignore to prevent committing environment secrets. 

- **`NODE_ENV=production`**: Ensures production settings (e.g., mainnet chian).
- **`ENABLE_NGINX=true`**: By default, GCR limits requests to 32mb. When an nginx proxy is combined with the HTTP/2 passthrough on GCR, it increases the request size allowed.
- **`HTTP_PORT=8080`**: Cloud Run default.  
- **`SERVER_PRIVATE_KEY`**: Your server’s private key for authenticating requests (do **not** include quotes).  
- **`KNEX_DB_CONNECTION`**: Must be a valid JSON string (a string representation of a JSON object). When defined in env.yaml, it should be enclosed in single quotes to ensure YAML treats it as a string.

Then deploy your image using:

```bash
gcloud run deploy utxo-management-server \
  --image=gcr.io/PROJECT_ID/utxo-management-server:latest \
  --region=us-west1 \
  --platform=managed \
  --allow-unauthenticated \
  --env-vars-file=env.yaml
```
You can add `--use-http2`, if you want your container to see full HTTP/2 requests (especially relevant if you’re doing streaming gRPC or advanced HTTP/2 features in Nginx).

---

## 9. Verify Your Deployment

1. **Wait** for Cloud Run to finish deploying and note the service URL. 

Ex.
```bash
Service [utxo-management-server] revision [utxo-management-server-00004-6n3] has been deployed and is serving 100 percent of traffic.
Service URL: https://utxo-management-server-131201068103.us-west1.run.app
```

2. **Open** the Cloud Run URL in your browser (or use `curl`).  
3. Check logs in the [Cloud Run Console](https://console.cloud.google.com/run/) to confirm:
   - Service started without errors.  
   - Migrations succeeded, creating the required tables in `wallet_storage`.

You can also confirm table creation by connecting to your DB and running:
```SQL
  SHOW TABLES;
```

---

That’s it! You have now:

1. Created or connected to a MySQL instance (Cloud SQL or otherwise).
2. Created a `wallet_storage` database.
3. Configured environment variables in Cloud Run to point to that database.
4. Deployed your Docker container to Cloud Run.

Your UTXO Management Server should now be ready to handle requests. If you run into any database connectivity issues, double-check your connection string, credentials, and Cloud SQL networking/security settings.

---

## Next Steps

- Connect your BSV wallet client to the new Cloud Run endpoint (the *remote storage* URL).  
- Customize monetization, mutual auth, or additional route controllers as needed.  
- Add a CI/CD pipeline for automated builds and deployments.

---

## CI/CD with GitHub Actions (Optional)

You can automate Docker builds and GCR deployments using GitHub Actions:

1. **Add** your GitHub secrets:
   - `GCP_PROJECT_ID`
   - `GCP_SA_KEY` (service account JSON)
   - `KNEX_DB_CONNECTION`
   - `SERVER_PRIVATE_KEY`
2. **Create** a `.github/workflows/deploy.yaml`:

   ```yaml
    name: Deploy to Cloud Run

    on:
      push:
        branches: [ "master" ]

    jobs:
      build-and-deploy:
        runs-on: ubuntu-latest

        steps:
          - uses: actions/checkout@v3

          - name: Authenticate to Google Cloud
            uses: google-github-actions/auth@v1
            with:
              credentials_json: ${{ secrets.GCP_SA_KEY }}

          - name: Configure docker
            run: gcloud auth configure-docker

          - name: Build
            run: |
              docker build --platform linux/amd64 -t gcr.io/${{ secrets.GCP_PROJECT_ID }}/utxo-management-server:${{ github.sha }} .
          
          - name: Push Docker image
            run: |
              docker push gcr.io/${{ secrets.GCP_PROJECT_ID }}/utxo-management-server:${{ github.sha }}
          
          - name: Deploy
            run: |
              gcloud run deploy utxo-management-server \
                --image gcr.io/${{ secrets.GCP_PROJECT_ID }}/utxo-management-server:${{ github.sha }} \
                --region=us-west1 \
                --platform=managed \
                --allow-unauthenticated \
                --use-http2 \
                --env-vars-file=env.yaml
   ```

Whenever you push to `master`, this workflow will build, push, and deploy automatically.

---

### You’re All Set!

You now have a **production-ready** UTXO Management Server running on Cloud Run and connected to a secure MySQL database. For further customization or troubleshooting:

- Check the [Cloud SQL MySQL docs](https://cloud.google.com/sql/docs/mysql) and [Cloud Run docs](https://cloud.google.com/run/docs).
- Review and tweak environment variables, server code, or Nginx configurations as desired.  

Enjoy building on the BSV Blockchain with a robust wallet infrastructure!