# KVStore Services

A modern TypeScript implementation of the KVStore lookup service for BSV blockchain, following the overlay services architecture.

## Overview

This monorepo contains a complete KVStore lookup service implementation built with:
- **TypeScript**: Full type safety and modern ES modules
- **MongoDB**: Efficient storage with proper indexing
- **Overlay Protocol**: Compatible with @bsv/overlay architecture
- **Comprehensive Testing**: Unit tests with MongoDB Memory Server

## Project Structure

```
kvstore-services/
├── backend/                 # Main service implementation
│   ├── src/
│   │   ├── KVStoreStorageManager.ts      # MongoDB storage layer
│   │   ├── KVStoreLookupServiceFactory.ts # Lookup service implementation  
│   │   ├── types.ts                       # TypeScript interfaces
│   │   ├── docs/                          # Documentation
│   │   └── __tests/                       # Unit tests
│   ├── dist/                # Compiled output
│   └── package.json         # Backend dependencies
└── package.json            # Root package configuration
```

## Installation

```bash
# Clone and install dependencies
git clone https://github.com/p2ppsr/kvstore-services.git
cd kvstore-services
npm install
npm run install-deps

# Build the project
npm run build
```

## Usage

### Basic Setup

```typescript
import { MongoClient } from 'mongodb'
import KVStoreLookupServiceFactory from '@bsv/kvstore-services/backend'

// Connect to MongoDB
const client = new MongoClient('mongodb://localhost:27017')
await client.connect()
const db = client.db('kvstore')

// Create lookup service
const lookupService = KVStoreLookupServiceFactory(db)
```

### Query Examples

```typescript
// Find by protected key
const results = await lookupService.lookup({
  service: 'ls_kvstore',
  query: {
    protectedKey: 'dGVzdC1wcm90ZWN0ZWQta2V5',
    limit: 50,
    skip: 0,
    sortOrder: 'desc'
  }
})

// With history tracking
const resultsWithHistory = await lookupService.lookup({
  service: 'ls_kvstore',
  query: {
    protectedKey: 'dGVzdC1wcm90ZWN0ZWQta2V5',
    history: true
  }
})
```

## Development

```bash
# Install dependencies
npm run install-deps

# Build
npm run build

# Run tests
npm test

# Lint
npm run lint

# Development mode (watch)
npm run dev
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

## Migration from JavaScript Version

This TypeScript implementation replaces the original JavaScript version with:

✅ **Modern Architecture**: ES modules, TypeScript, overlay protocol compliance  
✅ **Better Storage**: MongoDB with proper indexing vs. Knex/SQL  
✅ **Type Safety**: Full TypeScript interfaces and type checking  
✅ **Comprehensive Testing**: Unit tests with in-memory MongoDB  
✅ **Better Documentation**: Generated docs and examples  
✅ **Performance**: Optimized queries and caching  

## License

SEE LICENSE IN LICENSE.txt
