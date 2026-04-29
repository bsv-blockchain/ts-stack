---
id: pkg-btms-backend
title: "@bsv/btms-backend"
kind: package
domain: overlays
version: "0.1.0"
source_repo: "bsv-blockchain/btms-backend"
source_commit: "unknown"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
npm: "https://www.npmjs.com/package/@bsv/btms-backend"
repo: "https://github.com/bsv-blockchain/btms-backend"
status: experimental
tags: [tokens, btms, backend, mongodb]
---

# @bsv/btms-backend

Backend infrastructure for BTMS — MongoDB storage, topic manager, and lookup service for the BTMS token overlay.

## Install

```bash
npm install @bsv/btms-backend
```

## Quick start

```typescript
import { BTMSBackend } from '@bsv/btms-backend';
import { OverlayExpress } from '@bsv/overlay-express';
import express from 'express';

const app = express();
const overlay = new OverlayExpress(app);

// Initialize BTMS backend with MongoDB
const btmsBackend = new BTMSBackend({
  mongoUri: 'mongodb://localhost:27017/btms'
});

// Register topic and lookup service
overlay.addTopicManager('btms', btmsBackend.getTopicManager());
overlay.addLookupService('btms', btmsBackend.getLookupService());

app.listen(3000);
```

## What it provides

- **MongoDB integration** — Persistent storage for token metadata and transactions
- **Topic Manager** — Validates and indexes BTMS token transactions
- **Lookup Service** — Query tokens by ID, owner, or other properties
- **Token indexing** — Track token supply, transfers, and ownership
- **Pagination** — Support efficient querying of large token sets
- **Event logging** — Track all token operations and history
- **Permission checking** — Integrate with @bsv/btms-permission-module
- **Broadcast integration** — Hook into transaction broadcasts from network

## When to use

- Running a BTMS overlay node in production
- Providing token metadata and discovery services
- Building a token registry or explorer
- Implementing token-based applications with persistent storage
- Synchronizing token state across multiple nodes with GASP

## When not to use

- For client-side token operations — use @bsv/btms
- If you don't need persistent storage — use in-memory overlay only
- For non-token overlays — use @bsv/overlay or @bsv/overlay-topics
- For development without MongoDB — use @bsv/overlay-topics memory backend

## API reference

Full TypeScript API documentation: [TypeDoc](https://bsv-blockchain.github.io/ts-stack/api/btms-backend/)

## Related packages

- @bsv/btms — Token operations from client perspective
- @bsv/btms-permission-module — Permission checking for tokens
- @bsv/overlay-express — HTTP server for backend
- @bsv/gasp — Synchronize token state between nodes
