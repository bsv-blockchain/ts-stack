# Running Wallet-Infra Locally

This guide explains how to run the UTXO Management Server **locally** using **Docker Compose**. This will spin up two containers:

1. A MySQL container
2. The “utxo-management-server” container with Node.js

### Requirements

- **Docker** installed (v20+ recommended)
- **Node.js** installed if you plan to run `npm install` locally (v18+ recommended)
- **Git** for code management (optional but typical)

### Steps

1. **Clone this repository**:
   ```bash
   git clone https://github.com/bitcoin-sv/wallet-infra.git
   cd wallet-infra
   ```

2. **Install and build local dependencies** (optional but helpful if you intend to run build steps outside Docker):
   ```bash
   npm install
   npm run build
   ```

3. **Configure environment variables**: 
   - Typically done inside the `docker-compose.yml`. 
   - By default, we have:

     ```yaml
     environment:
       NODE_ENV: "development"
       BSV_NETWORK: "test" # main | test | teratest | mock
       HTTP_PORT: "8080"
       SERVER_PRIVATE_KEY: "bffe0d7a3f7effce2b3511323c6cca1df1649e41a336a8b603194d53287ad285"
       KNEX_DB_CONNECTION: '{"host":"mysql","user":"root","password":"rootPass","database":"wallet_storage","port":3306}'
       # LEGACY_UPGRADE: "true"        # only when upgrading an existing v2 database (see below)
       # ARC_URL: "https://arcade-v2-us-1.bsvblockchain.tech"   # ARC endpoint (non-mock chains only)
       # ARC_API_KEY: "..."                                    # ARC API key (overrides TAAL_API_KEY)
       # ARC_CALLBACK_TOKEN: "..."                             # Enables TaskArcSSE proof callbacks
     ```
   - You can edit these in `docker-compose.yml` to suit your environment.
   - **v3 schema (default)**: fresh installs land on the v3 layout automatically at boot — no flag required. The server runs `migrate()` then auto-detects empty `transactions` + missing `transactions_legacy` and silently initializes v3 (logs `Fresh install detected — initializing v3 schema…`). No operator action needed.
   - **Upgrading from v2**: if the server detects legacy `transactions` rows but no `transactions_legacy` marker, it refuses to boot. Back up the DB, then set `LEGACY_UPGRADE=true` and restart, OR run `pnpm run cutover` standalone during a maintenance window and restart the server (so `StorageKnex._postCutoverCache` re-evaluates). See `@bsv/wallet-toolbox` `docs/CUTOVER_RUNBOOK.md` for the full operator runbook.

4. **Run Docker Compose**:

Make sure Docker is running on your machine, then run the following command:
   ```bash
   docker compose up --build
   ```
   - This will:
     - **Build** the Node image from the included `Dockerfile`.
     - **Launch** the MySQL container (exposing `3306` to your machine).
     - **Launch** the Node container, automatically running migrations at startup.
     - Node server will listen on port `8080` (mapped to `localhost:8080`).

5. **Check logs**:
   - You should see something like:
     ```
     utxo-management-server  | wallet-storage server v0.4.5
     utxo-management-server  | wallet-storage server started
     ```
   - This indicates the system is ready and listening on `http://localhost:8080`.

6. **Connect a wallet client**:
   - Configure your client so that the “remote storage” is at `http://localhost:8080` (or the relevant host/port).
   - The server manages your UTXOs in MySQL.

7. **Stopping**:
   ```bash
   docker compose down
   ```

That’s it for local development. Each time you change code, you can re-run `docker-compose up --build` or rely on volume mounting for hot reload (though be mindful of overwriting `node_modules`).
