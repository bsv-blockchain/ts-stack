---
id: guide-overlay-node
title: "Run an Overlay Node"
kind: guide
version: "1.0.0"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
status: stable
tags: [guide, overlay, infrastructure, deployment]
---

# Run an Overlay Node

Deploy and operate an overlay node that indexes and serves transaction data.

## What You'll Learn

- How overlay nodes work
- Setting up overlay-express
- Configuring topic managers
- Connecting to peers
- Handling SHIP/SLAP requests

## What You'll Build

A production-ready overlay node that:
1. Accepts transactions via SHIP
2. Responds to lookups via SLAP
3. Manages topics for data discovery
4. Syncs state with other nodes

## Prerequisites

- Docker or Node.js 18+
- PostgreSQL or MongoDB
- Bitcoin Core or Bitcore
- Understanding of overlay networks

## Stack

- @bsv/overlay-express — HTTP overlay server
- @bsv/gasp — Graph synchronization
- @bsv/overlay-topics — Topic management

## Getting Started

See full guide at `/docs/guides/run-overlay-node-full/`.

## Key Concepts

### Overlay Topics

Topics organize data for discovery:

```typescript
const topicManager = {
  name: 'transactions',
  description: 'All network transactions',
  schema: 'transaction-v1'
};
```

### SHIP (Submit)

Accept transactions:

```
POST /submit
{
  "tx": "<hex-encoded transaction>"
}
```

### SLAP (Lookup)

Query transactions:

```
GET /lookup?txid=<txid>
```

## Deployment Options

### Local Development
```bash
docker compose up
```

### Production
- Kubernetes cluster
- PostgreSQL 14+
- Redis cache
- Load balancer

## Network Topology

Nodes connect peer-to-peer:

```
Node A ←→ Node B ←→ Node C
  ↓        ↓        ↓
Bitcoin Network
```

## Monitoring

Health endpoint:

```bash
curl http://localhost:3001/health
```

## Next Steps

- [Overlay HTTP Spec](/docs/specs/overlay-http/) — API details
- [Overlay Server Infrastructure](/docs/infrastructure/overlay-server/) — Deployment guide
- [GASP Sync Protocol](/docs/specs/gasp-sync/) — Synchronization protocol
