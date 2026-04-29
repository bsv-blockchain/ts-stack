---
id: infra-wallet-infra
title: "Wallet Infrastructure Services"
kind: infra
version: "2.0.4"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
status: stable
tags: [wallet, infrastructure, jobs, monitoring, services]
---

# Wallet Infrastructure Services

## Overview

Wallet Infrastructure provides supporting services for wallet operations. It includes database migration tools, background job processors, wallet health monitoring, and key rotation services.

Built with `@bsv/wallet-infra@2.0.4`.

## What It Does

- **Database migrations** — Schema initialization and upgrades
- **Background jobs** — Process transactions, update balances
- **Health monitoring** — Alert on wallet issues
- **Key rotation** — Manage key lifecycle
- **Cleanup tasks** — Archive old data, expire sessions
- **Metrics collection** — Track wallet performance

## Components

### Migration Service

Manages database schema versions:

```bash
docker run bsv/wallet-infra:2.0.4 migrate up
docker run bsv/wallet-infra:2.0.4 migrate status
docker run bsv/wallet-infra:2.0.4 migrate rollback
```

### Job Processor

Processes background tasks:

```bash
docker run -d \
  -e DATABASE_URL=postgresql://... \
  -e REDIS_URL=redis://redis:6379 \
  -e WORKER_CONCURRENCY=10 \
  bsv/wallet-infra:2.0.4 worker
```

### Health Monitor

Checks wallet status and alerts:

```bash
docker run -d \
  -e DATABASE_URL=postgresql://... \
  -e ALERT_WEBHOOK=https://... \
  bsv/wallet-infra:2.0.4 monitor
```

### Key Rotation Service

Manages key lifecycle:

```bash
docker run -d \
  -e DATABASE_URL=postgresql://... \
  -e ROTATION_INTERVAL_DAYS=90 \
  bsv/wallet-infra:2.0.4 key-rotator
```

## Running with Docker Compose

```yaml
version: '3.8'
services:
  redis:
    image: redis:7
    ports:
      - "6379:6379"

  postgres:
    image: postgres:14
    environment:
      POSTGRES_DB: wallet
      POSTGRES_PASSWORD: walletpass
    volumes:
      - postgres_data:/var/lib/postgresql/data

  # Database migrations
  migrator:
    image: bsv/wallet-infra:2.0.4
    command: migrate up
    environment:
      DATABASE_URL: postgresql://postgres:walletpass@postgres:5432/wallet
    depends_on:
      - postgres

  # Background job processor
  worker:
    image: bsv/wallet-infra:2.0.4
    command: worker
    environment:
      DATABASE_URL: postgresql://postgres:walletpass@postgres:5432/wallet
      REDIS_URL: redis://redis:6379
      WORKER_CONCURRENCY: 10
    depends_on:
      - postgres
      - redis

  # Health monitoring
  monitor:
    image: bsv/wallet-infra:2.0.4
    command: monitor
    environment:
      DATABASE_URL: postgresql://postgres:walletpass@postgres:5432/wallet
      ALERT_WEBHOOK: ${ALERT_WEBHOOK}
    depends_on:
      - postgres

  # Key rotation
  key-rotator:
    image: bsv/wallet-infra:2.0.4
    command: key-rotator
    environment:
      DATABASE_URL: postgresql://postgres:walletpass@postgres:5432/wallet
      ROTATION_INTERVAL_DAYS: 90
    depends_on:
      - postgres

volumes:
  postgres_data:
```

## Environment Variables

### Common to All Services
| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `LOG_LEVEL` | No | info | Logging level |

### Job Processor
| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `REDIS_URL` | Yes | — | Redis connection |
| `WORKER_CONCURRENCY` | No | 5 | Concurrent job processing |
| `JOB_TIMEOUT_MS` | No | 30000 | Max job duration |

### Health Monitor
| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `ALERT_WEBHOOK` | Yes | — | Webhook for alerts |
| `CHECK_INTERVAL_SECONDS` | No | 300 | Health check frequency |
| `ALERT_THRESHOLD` | No | 3 | Failures before alerting |

### Key Rotator
| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `ROTATION_INTERVAL_DAYS` | No | 90 | Key rotation schedule |
| `ARCHIVE_OLD_KEYS` | No | true | Keep old keys in archive |
| `NOTIFY_USERS` | No | false | Email users on rotation |

## Database Migrations

Schema versions are tracked:

```
wallet_migrations
  id SERIAL PRIMARY KEY,
  version INT UNIQUE,
  name VARCHAR(255),
  sql TEXT,
  executed_at TIMESTAMP DEFAULT NOW(),
  INDEX (version)
```

View migration status:

```bash
docker compose exec wallet-infra migrate status
v1 (2026-01-01) — Create base schema
v2 (2026-02-15) — Add key rotation fields
v3 (2026-03-20) — Add health check tables
v4 (2026-04-10) — Optimize indexes
```

## Background Jobs

Job queue in Redis:

```yaml
job_types:
  update_balance:
    description: "Recalculate wallet balance"
    schedule: "*/5 * * * *"  # Every 5 minutes
    timeout: 30000

  sync_transactions:
    description: "Fetch new transactions from blockchain"
    schedule: "*/10 * * * *"  # Every 10 minutes
    timeout: 60000

  cleanup_expired_sessions:
    description: "Delete expired user sessions"
    schedule: "0 3 * * *"  # Daily at 3 AM
    timeout: 3600000

  archive_old_data:
    description: "Archive transactions older than 1 year"
    schedule: "0 2 * * 0"  # Weekly
    timeout: 86400000

  rotate_keys:
    description: "Rotate wallet keys"
    schedule: "0 1 * * *"  # Daily
    timeout: 1800000
```

## Health Checks

The monitor tracks wallet health:

```
checks:
  database_connectivity: OK
  redis_connectivity: OK
  key_validity: OK (5234 keys active)
  balance_sync: WARNING (5 wallets 10+ min stale)
  transaction_confirmation: OK (0 pending > 1 hour)
  disk_space: OK (45% used)
  memory_usage: OK (62% used)
```

Alert webhook payload:

```json
{
  "timestamp": "2026-04-28T10:30:00Z",
  "severity": "WARNING",
  "check": "balance_sync",
  "message": "5 wallets have stale balances (10+ minutes)",
  "affected_wallets": 5,
  "recommended_action": "Review database connectivity"
}
```

## Monitoring Metrics

Prometheus metrics exported:

```
wallet_info_total{wallet_id} — Total wallets
wallet_balance_satoshis{wallet_id} — Current balance
wallet_transactions_total{wallet_id} — Transactions
wallet_keys_active{wallet_id} — Active keys
wallet_utxos_available{wallet_id} — Available UTXOs
job_queue_length — Pending jobs
job_duration_seconds — Job processing time
database_query_duration_seconds — Query latency
```

## Scaling

For large deployments:

- **Multiple workers** — Scale job processing horizontally
- **Redis cluster** — Distribute job queue
- **Database replicas** — Read-only monitoring queries
- **Monitoring sidecar** — Dedicated health check instance

## Upgrading

```bash
# Backup database
pg_dump $DATABASE_URL > backup_$(date +%s).sql

# Migrate schema
docker compose run wallet-infra migrate up

# Restart all services
docker compose up -d

# Verify health
docker compose logs monitor
```

## Troubleshooting

**Jobs not processing**: Check Redis connectivity, monitor worker logs.

**Migration failures**: Review migration SQL, check database permissions.

**Health check alerts**: Verify database and network connectivity.

**Key rotation delays**: Check background job queue, increase worker concurrency.

## References

- [WAB (Wallet Abstraction Backend)](/docs/infrastructure/wab/)
- [Wallet-Toolbox Package](/docs/packages/wallet-toolbox/)
- [Building Wallet-Aware Apps](/docs/guides/wallet-aware-app/)
