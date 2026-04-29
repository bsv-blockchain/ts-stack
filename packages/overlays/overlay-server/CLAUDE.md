# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This repository provides ready-to-run configuration examples for standalone Overlay nodes built with `@bsv/overlay-express`. It implements various BSV blockchain overlay services (topic managers and lookup services) that enable distributed applications to organize and query blockchain data efficiently.

## Development Commands

```bash
# Install dependencies
npm install

# Development with hot-reload (uses tsx)
npm run dev

# Build TypeScript to dist/
npm run build

# Run production build
npm start

# Docker Compose (full stack: app + MongoDB + MySQL)
docker compose up --build
```

## Environment Configuration

All configuration is supplied via environment variables in `.env`. See `.env.example` for required variables:

- **NODE_NAME**: One-word, lowercase overlay service node identifier
- **SERVER_PRIVATE_KEY**: 32-byte hex root private key for server wallet
- **HOSTING_URL**: Public URL where the node is reachable
- **ADMIN_TOKEN**: Token for admin API access
- **WALLET_STORAGE_URL**: BSV wallet storage endpoint (e.g., `https://store-us-1.bsvb.tech`)
- **NETWORK**: `main` or `test` (BSV blockchain network)
- **ARC_API_KEY**: ARC key for transaction broadcasting
- **MONGO_URL**: MongoDB connection string
- **KNEX_URL**: MySQL connection string for Knex
- **GASP_ENABLED**: `true` or `false` (Graph Aware Sync Protocol for overlay sync)

## Architecture

### Core Components

The application bootstraps in [src/index.ts](src/index.ts):

1. **OverlayExpress Server** - Main server instance configured with identity, hosting URL, and admin access
2. **WalletAdvertiser** - Manages BSV wallet and creates advertisements for the overlay
3. **Database Connections** - Knex (MySQL) and MongoDB connections
4. **Topic Managers** - Validate which transaction outputs are admissible to the overlay
5. **Lookup Services** - Enable querying and retrieving data from the overlay

### Topic Managers & Lookup Services Pattern

Each overlay service consists of a **Topic Manager** and **Lookup Service** pair:

- **Topic Manager**: Implements `identifyAdmissibleOutputs(beef, previousCoins)` to validate transaction outputs. Each manager:
  - Decodes outputs using PushDrop (BRC-48 standard)
  - Validates data format and structure
  - Verifies signatures and cryptographic proofs
  - Returns `AdmittanceInstructions` with `outputsToAdmit` and `coinsToRetain`

- **Lookup Service**: Implements storage and query methods:
  - `outputAdmittedByTopic(payload)` - Store admitted outputs
  - `outputSpent(payload)` - Handle spent outputs
  - `lookup(question)` - Query stored data
  - Factory pattern: exported as function taking `Db` (MongoDB) and returning service instance

### Service Structure

Services are organized in [src/services/](src/services/) with consistent patterns:

```
src/services/{service-name}/
  ├── {Service}TopicManager.ts       # Validates outputs
  ├── {Service}LookupServiceFactory.ts  # Query interface
  ├── {Service}StorageManager.ts     # Data persistence
  ├── {Service}Types.ts              # TypeScript types
  ├── {Service}TopicDocs.ts          # Topic documentation
  └── {Service}LookupDocs.md.ts      # Lookup documentation
```

### Implemented Services

The following overlay services are configured in [src/index.ts](src/index.ts):

1. **ProtoMap** (`tm_protomap`, `ls_protomap`) - Protocol information registry
2. **CertMap** (`tm_certmap`, `ls_certmap`) - Certificate mapping
3. **BasketMap** (`tm_basketmap`, `ls_basketmap`) - Basket management
4. **UHRP** (`tm_uhrp`, `ls_uhrp`) - Universal Hash Resolution Protocol
5. **Identity** (`tm_identity`, `ls_identity`) - Identity services
6. **MessageBox** (`tm_messagebox`, `ls_messagebox`) - Message storage
7. **UMP** (`tm_users`, `ls_users`) - User management protocol
8. **HelloWorld** (`tm_helloworld`, `ls_helloworld`) - Simple messaging example
9. **SlackThreads** (`tm_slackthread`, `ls_slackthread`) - Slack-style threads
10. **DesktopIntegrity** (`tm_desktopintegrity`, `ls_desktopintegrity`) - Desktop app integrity verification
11. **Fractionalize** (`tm_fractionalize`, `ls_fractionalize`) - Fractional ownership
12. **Any** (`tm_anytx`, `ls_anytx`) - Generic transaction storage
13. **Apps** (`tm_apps`, `ls_apps`) - Application registry
14. **DID** (`tm_did`, `ls_did`) - Decentralized identifiers
15. **WalletConfig** (`tm_walletconfig`, `ls_walletconfig`) - Wallet configuration service discovery

### Key Technical Patterns

#### Topic Manager Implementation
```typescript
async identifyAdmissibleOutputs(beef: number[], previousCoins: number[]): Promise<AdmittanceInstructions> {
  const outputsToAdmit: number[] = []
  const parsedTransaction = Transaction.fromBEEF(beef)

  for (const [i, output] of parsedTransaction.outputs.entries()) {
    try {
      const { fields, lockingPublicKey } = PushDrop.decode(output.lockingScript)
      // Validate fields and verify signature
      // If valid, push to outputsToAdmit
    } catch (error) {
      continue // Invalid outputs are silently skipped
    }
  }

  return { outputsToAdmit, coinsToRetain: [] }
}
```

#### Lookup Service Factory Pattern
```typescript
export default (db: Db): ServiceLookupService => {
  return new ServiceLookupService(new ServiceStorageManager(db))
}
```

#### Server Configuration Pattern
```typescript
// Topic managers use 'new' instantiation
server.configureTopicManager('tm_name', new ServiceTopicManager())

// Lookup services use factory functions
server.configureLookupServiceWithMongo('ls_name', ServiceLookupServiceFactory)
```

### BSV SDK Usage

This codebase extensively uses `@bsv/sdk` for:
- **Transaction parsing**: `Transaction.fromBEEF(beef)`
- **PushDrop decoding**: `PushDrop.decode(lockingScript)` - BRC-48 standard
- **Key derivation**: `KeyDeriver` for deriving public keys from protocols
- **Signature verification**: `lockingPublicKey.verify()` and `ProtoWallet.verifySignature()`
- **Data encoding**: `Utils.toUTF8()`, `Utils.toHex()`

### Database Usage

- **MongoDB**: Primary storage for lookup service data (indexed queries)
- **MySQL/Knex**: Used by OverlayExpress engine for transaction tracking
- Storage managers handle MongoDB collections with CRUD operations

## Deployment

### Docker
- Multi-stage [Dockerfile](Dockerfile) builds TypeScript and runs production server
- [docker-compose.yml](docker-compose.yml) includes app, MongoDB, MySQL, and janitor services
- Janitor service runs cron job to clean stale tokens via `/admin/janitor` endpoint

### Kubernetes
Deployment files in [deploy/](deploy/):
- `app-deployment.yaml` - Main application deployment
- `app-service.yaml` - Service configuration
- `mongodb-deployment.yaml` + `mongodb-service.yaml` - MongoDB setup
- `mysql-deployment.yaml` + `mysql-service.yaml` - MySQL setup
- `janitor-cronjob.yaml` - Scheduled cleanup job
- Persistent volumes for database storage

## Adding New Services

To add a new overlay service:

1. Create service directory in `src/services/{service-name}/`
2. Implement `TopicManager` with `identifyAdmissibleOutputs()` method
3. Implement `LookupService` with `outputAdmittedByTopic()`, `outputSpent()`, and `lookup()` methods
4. Create `StorageManager` for MongoDB persistence
5. Define TypeScript types in `types.ts`
6. Add documentation in `*Docs.ts` files
7. Register in `src/index.ts`:
   ```typescript
   server.configureTopicManager('tm_{name}', new ServiceTopicManager())
   server.configureLookupServiceWithMongo('ls_{name}', ServiceLookupServiceFactory)
   ```

## Important Notes

- Topic manager IDs start with `tm_`, lookup service IDs with `ls_`
- Topic managers validate cryptographic proofs and signatures
- Invalid outputs should be silently skipped in topic managers (don't throw errors)
- Lookup services use factory pattern returning instances from MongoDB connection
- GASP sync enables multi-node overlay synchronization (disable for simple local deployments)
- Server listens on port 8080 by default
- Admin API requires `ADMIN_TOKEN` in Authorization header
