---
id: infra-overview
title: "Infrastructure"
kind: meta
version: "1.0.0"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
status: stable
tags: [infrastructure, deployment, services]
---

# Infrastructure

Infrastructure pages document deployed services — not npm packages, but applications you run in containers or on servers. These are reference implementations and production-grade services for running parts of the ts-stack.

## Services Overview

| Component | Package | Purpose |
|-----------|---------|---------|
| message-box-server | @bsv/messagebox-server 1.1.5 | Host MessageBox overlay for authenticated messaging |
| overlay-server | @bsv/overlay-express-examples 2.1.6 | Reference overlay node with transaction routing |
| uhrp-server-basic | @bsv/uhrp-lite 0.1.0 | Simple UHRP storage using local filesystem |
| uhrp-server-cloud-bucket | @bsv/uhrp-storage-server 0.2.1 | Cloud-bucket UHRP storage for production |
| wab | @bsv/wab-server 1.4.1 | Wallet Abstraction Backend — HTTP wallet service |
| wallet-infra | @bsv/wallet-infra 2.0.4 | Supporting services for wallet operations |

## Deployment Models

### Development / Testing
- Run locally with Docker Compose
- Use SQLite or in-memory stores
- Single instance, no clustering

### Production
- Kubernetes or Docker Swarm orchestration
- PostgreSQL or MongoDB backend
- Multi-zone redundancy
- Load balancing and health checks

## Common Requirements

All infrastructure services require:
- **Node.js 18+** — Runtime
- **Docker** — Containerization
- **Environment variables** — Configuration
- **Database** — Data persistence
- **Network access** — Inter-service communication

## Getting Started

1. Choose which services you need
2. Review the service documentation
3. Configure environment variables
4. Deploy using Docker or Kubernetes
5. Monitor health and logs

## References

Each service has detailed documentation on this page:
- Configuration options
- Environment variables
- Docker setup
- Database schema
- API endpoints
- Monitoring
