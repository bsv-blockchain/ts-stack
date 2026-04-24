# Overlay Express Examples

[![BSV License](https://img.shields.io/badge/license-Open%20BSV-blue)](#license)

A set of ready-to-run configuration examples for stand-alone Overlay nodes built with [`@bsv/overlay-express`](https://github.com/bsv-blockchain/overlay-express). Use these examples to spin-up your own overlay infrastructure for distributed applications on Bitcoin SV.

---

## Table of Contents
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Available NPM Scripts](#available-npm-scripts)
- [Docker Compose](#docker-compose)
- [Project Structure](#project-structure)
- [Contributing](#contributing)
- [License](#license)

## Prerequisites
1. **Node.js >= 20** (the container uses Node 22)  
2. **npm >= 10** (comes with Node).  
3. **Docker & Docker Compose** – only required if you want to run the full stack with MySQL and MongoDB from containers.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Create your .env file and set the variables listed below
cp .env.example .env || true   # if you keep a sample file in the repo

# 3. Start an overlay node in dev-watch mode
npm run dev
```

The service will start on `http://localhost:8080` by default. For production builds run `npm run build && npm start` or use Docker as described below.

## Configuration

All critical configuration is supplied through environment variables. Create a `.env` file in the project root (or use secrets in your orchestration platform) and define:

| Variable | Example | Description |
| -------- | ------- | ----------- |
| `NODE_NAME` | `my-overlay` | One-word, lowercase overlay service node identifier. |
| `SERVER_PRIVATE_KEY` | `6f5523…` | 32-byte hex root private key for the server's wallet for creating advertisements. |
| `HOSTING_URL` | `https://my.overlay.network` | Public URL where your node is reachable. |
| `ADMIN_TOKEN` | `supersecret` | Token required to access the admin API. |
| `WALLET_STORAGE_URL` | `https://store-us-1.bsvb.tech` | Wallet storage endpoint where advertisement tokens will be kept, and from where funds will be drawn. |
| `NETWORK` | `main` or `test` | BSV Blockchain network your node operates on. |
| `ARC_API_KEY` | — | Your ARC key for transaction broadcasting. |
| `MONGO_URL` | `mongodb://root:example@localhost:27017` | MongoDB connection string. |
| `KNEX_URL` | `mysql://user:pass@localhost:3306/appdb` | MySQL connection string used by Knex. |
| `GASP_ENABLED` | `true / false` | Enable Graph Aware Sync Protocol to sync with other overlays on the same topics. |

A complete example can be found in `docker-compose.yml`.

## Available NPM Scripts

| Script | Purpose |
| ------ | -------- |
| `npm run dev` | Starts the TypeScript source directly using [tsx](https://npm.im/tsx) with hot-reload – perfect for development. |
| `npm run build` | Compiles TypeScript into the `dist/` folder. |
| `npm start` | Runs the compiled JavaScript (`dist/index.js`). |

## Docker Compose

Spin-up the entire stack (Overlay node + MongoDB + MySQL) using:

```bash
docker compose up --build
```

This invokes the multi-stage `Dockerfile`, builds the TypeScript sources, and starts the server on port `8080`.

When the container is up you will see logs similar to:

```
OverlayExpress ▸ Server listening on port 8080
```

Press `Ctrl + C` to stop or add the `-d` flag to run in detached mode.

## Project Structure

```
.
├── src/               # TypeScript sources (topic managers, lookup services, bootstrapping)
├── deploy/            # Deployment helpers & scripts
├── docker-compose.yml # Container-based local environment
└── Dockerfile         # Production container image
```

## Contributing
Pull requests and issues are welcome! Please open an issue to discuss any major changes.

## License
Open BSV. See the [LICENSE](./LICENSE) file for details.