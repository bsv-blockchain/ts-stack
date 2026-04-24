# BTMS Backend

Backend services for the Basic Token Management System (BTMS) overlay network.

## Overview

BTMS is a UTXO-based token protocol built on the BSV blockchain that enables the creation, transfer, and management of fungible and non-fungible tokens. This backend provides the overlay services needed to index and query BTMS tokens.

## Role in BTMS

The backend is the BTMS overlay network layer:
- **Topic Manager** enforces protocol validity.
- **Lookup Service** indexes token state for queries.

## Related Docs

- Project index: [`../README.md`](../README.md)
- Main developer package (`@bsv/btms`): [`../core/README.md`](../core/README.md)
- Frontend app and live deployment (`https://btms.metanet.app`): [`../frontend/README.md`](../frontend/README.md)
- CARS deployment config: [`../deployment-info.json`](../deployment-info.json)

## Features

- **Topic Manager**: Validates token transactions and enforces protocol rules
- **Lookup Service**: Indexes tokens for efficient querying by asset ID or owner
- **MongoDB Storage**: Persistent storage for token UTXOs
- **Full Test Coverage**: Comprehensive test suite for all components

## Installation

```bash
npm install
```

## Usage

### Topic Manager

The `BTMSTopicManager` validates transactions and determines which outputs should be admitted to the overlay:

```typescript
import { BTMSTopicManager } from '@bsv/backend'

const topicManager = new BTMSTopicManager()

// Validate a transaction
const result = await topicManager.identifyAdmissibleOutputs(beef, previousCoins)
// Returns: { outputsToAdmit: number[], coinsToRetain: number[] }
```

### Lookup Service

The `BTMSLookupService` indexes admitted tokens and provides query capabilities:

```typescript
import BTMSLookupServiceFactory from '@bsv/backend'
import { MongoClient } from 'mongodb'

const client = new MongoClient('mongodb://localhost:27017')
await client.connect()
const db = client.db('btms')

// Create lookup service
const lookupService = BTMSLookupServiceFactory(db)

// Query tokens by asset ID
const results = await lookupService.lookup({
  service: 'ls_btms',
  query: { assetId: 'txid.0' }
})

// Query tokens by owner
const results = await lookupService.lookup({
  service: 'ls_btms',
  query: { ownerKey: '03abc...' }
})
```

## Protocol

BTMS tokens use PushDrop locking scripts with the following structure:

- **Field 0**: Asset ID (`"ISSUE"` for new tokens, or `"txid.outputIndex"` for existing)
- **Field 1**: Amount (numeric string)
- **Field 2**: Metadata (optional UTF-8 string)

### Token Rules

1. **Issuance**: New tokens are created with `assetId = "ISSUE"`
2. **Transfer**: Outputs cannot exceed input amounts for the same asset
3. **Metadata**: Must remain consistent across transfers if set during issuance
4. **Splitting**: Tokens can be split into multiple outputs
5. **Merging**: Multiple tokens of the same asset can be merged
6. **Burning**: Tokens are burned when spent without corresponding outputs

## Development

### Build

```bash
npm run build
```

### Test

```bash
npm test                 # Run all tests
npm run test:watch       # Watch mode
npm run test:coverage    # With coverage
```

### Lint

```bash
npm run lint
```

## API Documentation

For detailed API documentation, see:
- [Topic Manager Docs](./src/docs/BTMSTopicManagerDocs.ts)
- [Lookup Service Docs](./src/docs/BTMSLookupDocs.ts)

## Architecture

```
src/
├── topic-managers/
│   ├── BTMSTopicManager.ts          # Token validation logic
│   └── __tests/                     # Topic manager tests
├── lookup-services/
│   ├── BTMSLookupServiceFactory.ts  # Lookup service implementation
│   ├── BTMSStorageManager.ts        # MongoDB storage layer
│   ├── types.ts                     # Type definitions
│   ├── docs/                        # Service documentation
│   └── __tests/                     # Lookup service tests
└── docs/
    ├── BTMSTopicManagerDocs.ts      # Topic manager protocol docs
    └── BTMSLookupDocs.ts            # Lookup service protocol docs
```

## Configuration

### MongoDB Indexes

The storage manager automatically creates the following indexes:

- `assetId` - For asset-based queries
- `ownerKey` - For owner-based queries
- `{txid, outputIndex}` - Unique identifier (unique index)

### Overlay Integration

#### CARS Deployment (Recommended)

BTMS overlay backend is designed to be deployed as a CARS project. The `deployment-info.json` file defines the topic managers and lookup services to use:

Example:
```json
{
  "schema": "bsv-app",
  "schemaVersion": "1.0",
  "topicManagers": {
    "tm_btms": "./src/topic-managers/BTMSTopicManager.ts"
  },
  "lookupServices": {
    "ls_btms": {
      "serviceFactory": "./src/lookup-services/BTMSLookupServiceFactory.ts",
      "hydrateWith": "mongo"
    }
  },
  "configs": [
    {
      "name": "BTMS",
      "provider": "CARS",
      "CARSCloudURL": "https://cars.babbage.systems", // Or your own CARS instance
      "projectID": "your-project-id",
      "network": "mainnet",
      "deploy": ["backend"]
    }
  ]
}
```

## License

See LICENSE.txt

## Support

For issues and questions, please open an issue on the repository.
