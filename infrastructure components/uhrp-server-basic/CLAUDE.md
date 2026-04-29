# CLAUDE.md — UHRP Lite (Basic File Storage)

## Purpose
A simple, file-system based UHRP (Universal Host Reference Protocol) host server. Stores files locally on disk, provides HTTP GET/PUT/POST endpoints for UHRP data retrieval and storage, and bills users per GB/month. Designed as a lightweight alternative to cloud-based storage for developers wanting to run UHRP locally.

## Service surface
- **PUT /put/{hash}** – Upload file to local storage (authenticated, priced)
- **GET /{hash}** – Retrieve file from local storage (public)
- **POST /lookup** – UHRP lookup queries to find and metadata for stored files (public)
- **GET /info** – Server info and pricing details (public)
- **Health/readiness** – HTTP 200 on GET / (no explicit health endpoint)

## Real deployment
- **No Dockerfile** – Lightweight Node.js server only, uses ts-node directly
- **No docker-compose.yml** – Filesystem-based, no database dependencies
- **No nginx.conf** – Direct Express server on configured port
- **File storage** – Local filesystem (`/data` or `./public` by default, configurable via env)
- **No migrations** – Stateless server; files stored directly on disk with JSON metadata

## Configuration
Environment variables (from `.env.example`):
- **PRICE_PER_GB_MO** – Monthly storage price per GB (e.g., `0.03`)
- **HOSTING_DOMAIN** – Public domain for server advertisement (e.g., `localhost:8080` or `https://uhrp.example.com`)
- **BSV_NETWORK** – Target blockchain network (e.g., `mainnet` or `testnet`)
- **WALLET_STORAGE_URL** – Wallet storage endpoint for key derivation (e.g., `https://storage.babbage.systems`)
- **SERVER_PRIVATE_KEY** – 256-bit hex private key for server identity (required)
- **HTTP_PORT** – Express server port (default: 8080)
- **NODE_ENV** – `development` or `production`

## Dependencies
- **Database** – None; filesystem-based storage
- **@bsv packages**
  - `@bsv/sdk` – Cryptography, key operations
  - `@bsv/auth-express-middleware` – Request/response authentication for PUT
  - `@bsv/payment-express-middleware` – Price calculation and optional payment verification
  - `@bsv/wallet-toolbox-client` – Wallet client interface
- **External services**
  - Wallet Storage (via `WALLET_STORAGE_URL`) – Key derivation, payment validation
  - ARC / transaction broadcaster – Optional for payment transactions
- **Key packages** – Express, body-parser, dotenv, axios

## Operational concerns
- **Local dev** – `npm run dev` with nodemon hot-reload, stores files in `./public` or configured data dir
- **Production** – `npm run build && npm start` compiles TypeScript to `out/`, runs `node out/src/index.js`
- **File storage** – No cleanup mechanism; files persist until manually deleted. Monitor disk usage in production
- **Pricing** – PRICE_PER_GB_MO is advisory; actual payment enforcement depends on payment middleware configuration
- **Authentication** – PUT requires signed auth headers (BRC-103); GET/POST are public
- **Scaling** – Single instance; no built-in replication or load balancing
- **MIME types** – Auto-detected based on file extension via custom middleware

## Spec conformance
- **UHRP** – Implements basic UHRP host protocol for file storage and retrieval
- **BRC-103** – Mutual authentication on authenticated endpoints (PUT)
- **BRC-100** – Optional payment verification (via payment middleware)

## Integration points
- **UHRP clients** – Any UHRP-aware client can upload/retrieve files using SERVER_PRIVATE_KEY and HOSTING_DOMAIN
- **Wallet Storage** – Derives keys from SERVER_PRIVATE_KEY, validates payments
- **Overlay nodes** – Can advertise UHRP hosting capability via overlay

## File map
- **src/**
  - `index.ts` – Entry point: Express app setup, routes, auth middleware, payment integration
  - `routes/` – HTTP handlers: PUT, GET, lookup, info
  - `utils/` – Helpers: file pricing, wallet singleton, metadata retrieval, MIME type detection
  - `public/` – Static assets and uploaded file storage (configurable)
- **package.json** – Scripts: `dev`, `build`, `start`
- **.env.example** – Template with all required/optional variables
- **tsconfig.json** – TypeScript configuration
