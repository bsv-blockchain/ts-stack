# KVStore Overlay Services

An overlay service implementation for key-value storage on BSV blockchain.

## Overview

This repo provides:
- **KVStoreStorageManager**: MongoDB-based storage for KVStore records
- **KVStoreLookupService**: Overlay lookup service implementation  
- **KVStoreTopicManager**: Topic manager for handling KVStore transactions
- **Type definitions**: TypeScript interfaces for KVStore data structures

## Features

- **Modern TypeScript**: Full type safety with modern ES modules
- **MongoDB Integration**: Efficient storage with proper indexing
- **Overlay Protocol**: Compatible with @bsv/overlay architecture
- **History Tracking**: Chain tracking capabilities for KVStore tokens
- **Pagination**: Built-in pagination and sorting support

## Development Setup

This project uses the **LARS** (local) and **CARS** (cloud) toolchains to simplify development and deployment of overlay services.

### Getting Started

1. **Start LARS locally**:
```bash
npm run lars
# Select "Start LARS (local only)"
```

2. **The LARS environment provides**:
   - Local MongoDB instance for lookup service records
   - Local MySQL instance for overlay storage manager records
   - Overlay services infrastructure

3. **Services are automatically configured** via `deployment-info.json`:
```json
{
  "topicManagers": {
    "tm_kvstore": "./backend/src/KVStoreTopicManager.ts"
  },
  "lookupServices": {
    "ls_kvstore": {
      "serviceFactory": "./backend/src/KVStoreLookupServiceFactory.ts",
      "hydrateWith": "mongo"
    }
  }
}
```

### Lookup Service Queries

```typescript
// Find by key
const results = await lookupService.lookup({
  service: 'ls_kvstore',
  query: {
    key: 'user-profile'
  }
})

// Find by controller (public key)
const results = await lookupService.lookup({
  service: 'ls_kvstore', 
  query: {
    controller: '02f6e1e4c00f8a7e746f106a5d8a0b8a6b3e7c5f2d1e8b9a3c6f9e2d5b8a1f4e7c'
  }
})

// Combined query with pagination
const results = await lookupService.lookup({
  service: 'ls_kvstore', 
  query: {
    key: 'user-profile',
    controller: '02f6e1e4c00f8a7e746f106a5d8a0b8a6b3e7c5f2d1e8b9a3c6f9e2d5b8a1f4e7c',
    protocolID: [1, 'kvstore'],
    limit: 10,
    skip: 0,
    sortOrder: 'desc'
  }
})
```

## Protocol Details

### KVStore Token Structure (PushDrop Protocol)
- **Field 0**: Protocol ID (`[1, 'kvstore']` as JSON string)
- **Field 1**: Key (variable length UTF-8 string)
- **Field 2**: Value (variable length UTF-8 string) 
- **Field 3**: Controller (33-byte compressed ECDSA public key)
- **Field 4**: Signature (64-byte signature over fields 0-3)

### Service Configuration
- **Service ID**: `ls_kvstore`
- **Topic**: `tm_kvstore`
- **Protocol ID**: `[1, 'kvstore']`
- **Admission Mode**: `locking-script`
- **Spend Notification Mode**: `none`

### Query Capabilities
The lookup service supports filtering by:
- **key**: Find records with a specific key
- **controller**: Find records controlled by a specific public key
- **protocolID**: Find records for a specific protocol version
- **Pagination**: `limit`, `skip`, and `sortOrder` parameters
- **Combined filters**: Multiple criteria can be combined

### Database Schema
Records are stored in MongoDB with the following structure:
```typescript
interface KVStoreRecord {
  txid: string           // Transaction ID
  outputIndex: number    // Output index in transaction
  key: string           // The key from the KVStore token
  protocolID: string    // JSON-stringified protocol ID
  controller: string    // Public key (hex) that controls this token
  createdAt: Date       // When the record was stored
}
```

**Indexes**: Efficient lookups are enabled on `key`, `protocolID`, and `controller` fields.

## License

See [LICENSE.txt](LICENSE.txt) for license details.
