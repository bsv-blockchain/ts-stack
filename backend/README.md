# KVStore Services Backend

A modern TypeScript implementation of the KVStore lookup service for BSV blockchain, following the overlay services architecture.

## Overview

This package provides:
- **KVStoreStorageManager**: MongoDB-based storage for KVStore tokens
- **KVStoreLookupService**: Overlay lookup service implementation
- **Type definitions**: TypeScript interfaces for KVStore data structures

## Features

- **Modern TypeScript**: Full type safety with modern ES modules
- **MongoDB Integration**: Efficient storage with proper indexing
- **Overlay Protocol**: Compatible with @bsv/overlay architecture
- **History Tracking**: Chain tracking capabilities for KVStore tokens
- **Pagination**: Built-in pagination and sorting support

## Installation

```bash
npm install @bsv/kvstore-services-backend
```

## Usage

### Basic Setup

```typescript
import { MongoClient } from 'mongodb'
import KVStoreLookupServiceFactory from '@bsv/kvstore-services-backend'

// Connect to MongoDB
const client = new MongoClient('mongodb://localhost:27017')
await client.connect()
const db = client.db('kvstore')

// Create lookup service
const lookupService = KVStoreLookupServiceFactory(db)
```

### Storage Manager Usage

```typescript
import { KVStoreStorageManager } from '@bsv/kvstore-services-backend'

const storageManager = new KVStoreStorageManager(db)

// Store a KVStore record
await storageManager.storeRecord(
  'txid123...', 
  0, 
  'base64-encoded-protected-key'
)

// Find by protected key
const results = await storageManager.findByProtectedKey(
  'base64-encoded-protected-key',
  50, // limit
  0,  // skip
  'desc' // sort order
)
```

### Lookup Service Queries

```typescript
// Basic protected key lookup
const results = await lookupService.lookup({
  service: 'ls_kvstore',
  query: {
    protectedKey: 'dGVzdC1wcm90ZWN0ZWQta2V5'
  }
})

// With pagination and history
const results = await lookupService.lookup({
  service: 'ls_kvstore', 
  query: {
    protectedKey: 'dGVzdC1wcm90ZWN0ZWQta2V5',
    limit: 10,
    skip: 0,
    sortOrder: 'desc',
    history: true
  }
})
```

## Protocol Details

### KVStore Token Structure
- **Field 0**: Public Key (32 bytes)
- **Field 1**: OP_CHECKSIG
- **Field 2**: Protected Key (32 bytes) - indexed for lookups
- **Field 3**: Value (variable length)
- **Field 4**: Signature from Field 0 over Fields 2-3
- **Above 9**: OP_DROP / OP_2DROP operations

### Service Configuration
- **Service ID**: `ls_kvstore`
- **Topic**: `kvstore`
- **Admission Mode**: `locking-script`
- **Spend Notification Mode**: `none`

## API Reference

See the generated API documentation in `API.md` or use TypeScript IntelliSense for detailed type information.

## Development

```bash
# Install dependencies
npm install

# Build the project
npm run build

# Run tests
npm test

# Lint code
npm run lint
```

## License

SEE LICENSE IN LICENSE.txt
