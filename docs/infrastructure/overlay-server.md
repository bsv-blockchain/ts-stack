---
id: infra-overlay-server
title: "Overlay Server"
kind: infra
version: "2.1.6"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
status: stable
tags: [overlay, http, transaction-routing, service]
---

# Overlay Server

## Overview

The Overlay Server is a reference implementation of an overlay node built on @bsv/overlay-express. It handles transaction routing, lookup, and topic management for the overlay network.

Built with `@bsv/overlay-express-examples@2.1.6`, this service implements the Overlay HTTP API (SHIP/SLAP).

## What It Does

- **Accepts transactions** via SHIP (Synchronised Host Invoice Protocol)
- **Routes transactions** to the Bitcoin network
- **Responds to lookups** via SLAP (Synchronised Lookup Availability Protocol)
- **Manages topics** for service discovery and availability
- **Broadcasts updates** to connected peers
- **Validates transactions** before accepting

## Running with Docker

```bash
docker run -d \
  -e DATABASE_URL=postgresql://user:pass@postgres:5432/overlay \
  -e BITCOIN_RPC_URL=http://bitcoind:8332 \
  -e WALLET_ID=<your-wallet-id> \
  -e PRIVATE_KEY=<your-private-key> \
  -p 3001:3001 \
  bsv/overlay-server:2.1.6
```

## Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `BITCOIN_RPC_URL` | Yes | — | Bitcoin Core RPC endpoint |
| `WALLET_ID` | Yes | — | This node's wallet identifier |
| `PRIVATE_KEY` | Yes | — | This node's private key |
| `PORT` | No | 3001 | HTTP server port |
| `LOG_LEVEL` | No | info | Logging level |
| `OVERLAY_TOPICS` | No | transactions | Comma-separated topics to manage |
| `TOPIC_MANAGER` | No | file | Topic manager (file, redis, memory) |

## Topic Configuration

Configure topic managers for different data types:

```yaml
topics:
  transactions:
    description: "All network transactions"
    schema: "transaction-v1"
    retention_hours: 720

  utxos:
    description: "Available UTXOs"
    schema: "utxo-v1"
    retention_hours: 24

  contracts:
    description: "Smart contract deployments"
    schema: "contract-v1"
    retention_hours: 8760  # 1 year
```

## Database Schema

PostgreSQL tables:

```
transactions
  id UUID PRIMARY KEY,
  txid CHAR(64) UNIQUE,
  raw BYTEA,
  inputs INT,
  outputs INT,
  fee BIGINT,
  created_at TIMESTAMP

topics
  id UUID PRIMARY KEY,
  name VARCHAR(255) UNIQUE,
  description TEXT,
  schema_version VARCHAR(32),
  last_update TIMESTAMP

topic_events
  id BIGSERIAL PRIMARY KEY,
  topic_id UUID REFERENCES topics,
  event_data JSONB,
  created_at TIMESTAMP,
  INDEX (topic_id, created_at)
```

## Docker Compose Example

```yaml
version: '3.8'
services:
  postgres:
    image: postgres:14
    environment:
      POSTGRES_DB: overlay
      POSTGRES_PASSWORD: overlaypass
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data

  overlay:
    image: bsv/overlay-server:2.1.6
    environment:
      DATABASE_URL: postgresql://postgres:overlaypass@postgres:5432/overlay
      BITCOIN_RPC_URL: http://bitcoind:8332
      WALLET_ID: overlay-node-1
      PRIVATE_KEY: ${OVERLAY_PRIVATE_KEY}
    ports:
      - "3001:3001"
    depends_on:
      - postgres
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3001/health"]
      interval: 30s
      timeout: 10s
      retries: 3

volumes:
  postgres_data:
```

## Endpoints

The server exposes the Overlay HTTP API:

- `POST /submit` — Submit transaction (SHIP)
- `GET /lookup?txid=...` — Query transaction (SLAP)
- `POST /arc-ingest` — Receive ARC callbacks
- `GET /topics` — List available topics
- `GET /topics/{name}` — Get topic events
- `GET /health` — Health check

For full API details, see [Overlay HTTP Spec](/docs/specs/overlay-http/).

## Monitoring

Health endpoint returns:

```bash
curl http://localhost:3001/health
{
  "status": "healthy",
  "uptime": 7200,
  "transactions_stored": 42501,
  "topics_managed": 3,
  "blockchain_height": 850123
}
```

## Performance Tuning

- **Connection pooling** — Increase PostgreSQL pool for throughput
- **Topic sharding** — Distribute topics across servers
- **Caching** — Enable Redis for hot transaction lookups
- **Batch inserts** — Group topic events into batches

## Security Considerations

- **HTTPS required** in production
- **Bitcoin RPC auth** — Use HTTP basic auth or restrict to internal network
- **Database encryption** — Enable PostgreSQL encryption at rest
- **API rate limiting** — Configure per-IP request limits

## Upgrading

Backup your PostgreSQL before upgrading:

```bash
pg_dump $DATABASE_URL > backup_$(date +%s).sql
```

Then pull the new image:

```bash
docker pull bsv/overlay-server:2.1.6
docker compose up -d overlay
```

## Troubleshooting

**Transactions not appearing**: Verify Bitcoin RPC connectivity and transaction validity.

**Slow lookups**: Add database indexes, enable Redis caching.

**High memory usage**: Reduce topic retention periods, archive old events.

## References

- [Overlay Express Package](/docs/packages/overlay-express/)
- [Overlay HTTP Spec](/docs/specs/overlay-http/)
- [GASP Sync Protocol](/docs/specs/gasp-sync/)
- [Running an Overlay Node Guide](/docs/guides/run-overlay-node/)
