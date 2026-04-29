---
id: infra-overview
title: "Infrastructure"
kind: meta
version: "1.0.0"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
status: stable
tags: [infrastructure, deployment, reference-implementations, ts-stack]
---

# Infrastructure

Infrastructure components are deployed services — not npm packages, but applications you run in Docker containers or on servers. These are reference implementations and production-grade services for running key parts of the ts-stack.

## Components Overview

| Component | Purpose | Database | Status | Deploy target |
|-----------|---------|----------|--------|----------------|
| [Message Box Server](message-box-server.md) | Secure peer-to-peer messaging with real-time WebSocket delivery | MySQL 8.0 | stable | Docker / Kubernetes |
| [Overlay Server](overlay-server.md) | Topic managers and lookup services for overlay network | MongoDB + MySQL/Knex | stable | Docker / Kubernetes |
| [UHRP Server (Basic)](uhrp-server-basic.md) | Lightweight file storage via local filesystem (dev/test) | None (filesystem) | beta | Local Docker |
| [UHRP Server (Cloud Bucket)](uhrp-server-cloud-bucket.md) | Production UHRP storage via Google Cloud Storage | Optional Cloud SQL | stable | Google Cloud Run |
| [Wallet Abstraction Backend (WAB)](wab.md) | Multi-factor user authentication (SMS, ID verification, OTP) | SQLite (dev) / MySQL (prod) | stable | Docker / Kubernetes / Cloud Run |
| [Wallet Infrastructure](wallet-infra.md) | JSON-RPC wallet UTXO storage and management | MySQL 8.0 | stable | Docker / Kubernetes |

## Decision Matrix: Which Services to Deploy

**Building a messaging app?**
- Deploy Message Box Server (MySQL backend, WebSocket support)
- Pair with Wallet Infrastructure for UTXO management if handling payments

**Building an overlay node?**
- Deploy Overlay Server (MongoDB + MySQL/Knex)
- Implement custom topic managers and lookup services, or use reference implementations (ProtoMap, CertMap, UHRP, Identity, etc.)

**Hosting UHRP files?**
- Development: UHRP Server (Basic) with local filesystem storage
- Production: UHRP Server (Cloud Bucket) on Google Cloud Run with Cloud Storage

**Providing wallet services?**
- Deploy WAB for user authentication and key recovery (presentation keys via SMS/ID verification)
- Deploy Wallet Infrastructure for UTXO storage (JSON-RPC endpoint)
- Combined, these enable wallet-aware applications with key backup/recovery

**Building BSV applications?**
- Deploy Message Box Server + Wallet Infrastructure for messaging + wallet capabilities
- Deploy WAB if you need multi-factor user authentication
- Deploy Overlay Server if you want to operate overlay services or coordinate with other overlay nodes

## Deployment Models

### Local Development
- Docker Compose with single-instance services
- SQLite or in-memory stores
- All services on localhost
- See each service's docker-compose.yml for example

### Docker/Kubernetes Production
- Alpine-based container images with Node 20-22
- Persistent volumes for databases
- Health checks and readiness probes configured
- Horizontal scaling via stateless design (except local in-memory state, e.g., WebSocket rooms)

### Cloud-Native (Google Cloud Run)
- UHRP Server (Cloud Bucket) designed for Cloud Run
- Stateless HTTP service with cloud bucket storage
- Optional Cloud SQL for metadata
- Graceful shutdown via SIGTERM

## Common Requirements

All infrastructure services:
- **Node.js 18+** – Runtime environment
- **Docker & docker-compose** – Local development and containerization
- **Environment variables** – Configuration (see each service's Configuration section)
- **Database** – Data persistence (MySQL, MongoDB, or filesystem; see table above)
- **Network access** – Services communicate via HTTP/WebSocket

## Prerequisites by Service

**Message Box Server**: MySQL 8.0, 3GB+ RAM, Docker
**Overlay Server**: MongoDB, MySQL/Knex, 4GB+ RAM, Docker
**UHRP Basic**: Local filesystem, 1GB+ disk, Docker (lightweight)
**UHRP Cloud**: Google Cloud account, Cloud Storage bucket, Cloud Run, optional Cloud SQL
**WAB**: SQLite (dev) or MySQL (prod), 2GB+ RAM, Docker
**Wallet Infrastructure**: MySQL 8.0, 2GB+ RAM, Docker

## Integration Points

- **Message Box + Wallet Infrastructure**: WAB authenticates users; Wallet Infrastructure stores their UTXOs. Together enable wallet messaging apps.
- **Overlay Server + All services**: Overlay advertises other services' capabilities via SHIP protocol (topic managers, lookup services, UHRP hosts, etc.)
- **WAB + UHRP Cloud**: Presentation key auth from WAB; UHRP Cloud can enforce payments via BRC-100 payment middleware
- **Wallet Infrastructure + Message Box**: Wallet infrastructure manages UTXOs; Message Box Server handles peer-to-peer communication

## Getting Started

1. **Identify use case** — Review Decision Matrix above
2. **Choose services** — Select from components table
3. **Read service docs** — Each service page has Configuration, Deployment, and Health Checks sections
4. **Configure env vars** — Copy .env.example, fill in required variables from Configuration tables
5. **Deploy locally** — Use docker-compose.yml from service or write custom docker-compose.yml
6. **Test endpoints** — Verify HTTP/WebSocket connectivity and health checks
7. **Deploy to production** — Follow Deploy to Production section with real database credentials, keys, and domains

## Source & References

- [ts-stack GitHub](https://github.com/bsv-blockchain/ts-stack)
- Each service has GitHub links in its documentation
- [BRC Standards](https://github.com/bitcoin-sv/brc) – Authentication (BRC-103), Wallet Interface (BRC-100), Payment (BRC-100), etc.
