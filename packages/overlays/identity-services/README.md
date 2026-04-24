# Identity Services (BSV Overlay)

A production-ready BSV overlay for validating, indexing, and resolving on-chain identity certificates.

This repository exposes:

- Topic manager: `tm_identity`
- Lookup service: `ls_identity`
- Backend exports via `backend/mod.ts`

These are wired in `deployment-info.json` for LARS/CARS execution and deployment.

## What this service does

1. Admits valid identity outputs from chain data (`IdentityTopicManager`).
2. Stores searchable identity certificate records in MongoDB (`IdentityStorageManager`).
3. Serves identity lookups by:
   - `attributes`
   - `identityKey`
   - `certificateTypes`
   - `serialNumber`
   - `certifiers`
   - optional pagination (`limit`, `offset`)

## Production readiness highlights

- Indexes for hot query paths (subject, certifier, serial number, userName, compound indexes, text index).
- Bounded and paginated lookup support (`limit`, `offset`).
- Handle-friendly `userName` exact-match query path.
- Test suite green from repository root (`npm run test`).

## Repository layout

```text
identity-services/
├── backend/
│   ├── src/
│   │   ├── IdentityLookupServiceFactory.ts
│   │   ├── IdentityTopicManager.ts
│   │   ├── IdentityStorageManager.ts
│   │   └── types.ts
│   ├── jest.config.cjs
│   ├── package.json
│   └── mod.ts
├── tests/
│   ├── IdentityLookupService.test.ts
│   ├── IdentityStorageManager.test.ts
│   └── IdentityTopicManager.test.ts
├── deployment-info.json
└── package.json
```

## Prerequisites

- Node.js 18+ (recommended)
- npm 9+
- Access to MongoDB for runtime hydration (`hydrateWith: "mongo"`)
- LARS/CARS tooling via repository scripts

## Installation

```bash
npm install
```

## Local development

```bash
# Configure local LARS settings
npm run lars

# Start local services defined in deployment-info.json
npm run start
```

## Testing

From repository root:

```bash
npm run test
npm run test:watch
npm run test:coverage
```

Notes:

- Root test commands delegate to backend Jest config.
- Tests include `backend/` and top-level `tests/` suites.

## Build and deploy

```bash
# Build deployment artifacts
npm run build

# Deploy configured target
npm run deploy
```

Before production deploy:

1. Review and update `deployment-info.json` `configs` for your infrastructure.
2. Remove placeholder or unused config entries.
3. Ensure your MongoDB instance has proper backup, monitoring, and access controls.
4. Verify network selection (`mainnet` vs `testnet`) per environment.

## Service contract summary

- Topic manager: `tm_identity`
- Lookup service: `ls_identity`
- Query fields (`IdentityQuery`):
  - `attributes?: Record<string, string>`
  - `certifiers?: PubKeyHex[]`
  - `identityKey?: PubKeyHex`
  - `certificateTypes?: Base64String[]`
  - `serialNumber?: Base64String`
  - `limit?: number`
  - `offset?: number`

## Helpful links

- [LARS](https://github.com/bsv-blockchain/lars)
- [CARS CLI](https://github.com/bsv-blockchain/cars-cli)
- [CARS Node](https://github.com/bsv-blockchain/cars-node)
- [deployment-info.json specification (BRC-102)](https://github.com/bitcoin-sv/BRCs/blob/master/apps/0102.md)

## License

[Open BSV License](./LICENSE.txt)
