# Wallet Infra - UTXO Management Server

This repository serves as a reference implementation for building and deploying BSV Wallet Infrastructure. It contains the configuration and code necessary to build and run a wallet storage server (also referred to as a “UTXO Management Server”). The server securely stores and manages UTXOs, providing a reliable backend for BSV wallet clients, all while never accessing user-held keys.

Built on the [wallet-toolbox](https://github.com/bsv-blockchain/wallet-toolbox), this implementation empowers developers with extensive customization options for authentication, monetization, and database management to name a few.

## Key Features

1. #### Out-of-the-Box UTXO Management
   - The server automatically handles all core wallet storage actions—storing transaction outputs (UTXOs), managing spent/unspent states, tracking labels, baskets, certificates, and more.
   - **Auto-migrations** on startup (via Knex).

2. #### Customizable Monetization  
   - By default, sets a `calculateRequestPrice` returning `0`, but you can easily **charge** clients in satoshis for each API call—either flat fees or **per-route** fees.
   - Using [`@bsv/payment-express-middleware`](https://github.com/bitcoin-sv/payment-express-middleware) in combination with the `monetize` flag, you can create a system that verifies micropayments on each request.

3. #### Mutual Authentication  
   - The server uses [`@bsv/auth-express-middleware`](https://github.com/bitcoin-sv/auth-express-middleware) to ensure that **both** the client and the server authenticate before a request is allowed through. 
   - This ensures that only authorized wallets can read or modify UTXO data.

4. #### Flexible Database Choice  
   - MySQL is used in this example (`mysql2` driver, `knex` config), however, you can integrate **any** DB driver that [Knex](https://knexjs.org/) supports—PostgreSQL, SQLite, etc. 

5. #### Extensible Codebase  
   - The `WalletStorageManager` class can handle multiple active or backup storage providers, letting you replicate or sync data across different backends.
   - The `StorageServer` class is an Express-based HTTP server that exposes a JSON-RPC endpoint. You can add your own routes, middlewares, or entire route controllers to further extend its functionality as needed for your [BRC-100](https://github.com/bitcoin-sv/BRCs/blob/master/wallet/0100.md) compliant wallet.

6. #### Just Defaults—Feel Free to Customize  
   - The code in `index.ts` is a basic example. Everything from `SERVER_PRIVATE_KEY`, `HTTP_PORT`, `KNEX_DB_CONNECTION`, to fee/commission handling can be **tweaked** in environment variables or replaced with your own logic.

---

## Deployment Options

Wallet Infra offers two main deployment paths, depending on your needs:

### Local Development

For quickly iterating on features and testing your wallet backend locally, follow the [**Local Development Guide**](./guides/local_development.md). This will walk you through spinning up a Docker Compose environment with MySQL and the Node.js server in minutes.

### Google Cloud Run Deployment

If you prefer a serverless, production-grade setup, follow the [**Google Cloud Deployment Guide**](./guides/gcloud_deployment.md) for detailed instructions on:
- Creating a MySQL database on Cloud SQL (or using your own DB)  
- Building and pushing the Docker image to Google Cloud  
- Deploying to Cloud Run with environment variables  
- Optional CI/CD with GitHub Actions  

---

## License

The license for the code in this repository is the Open BSV License. Refer to [LICENSE.txt](./LICENSE.txt) for the license text.
