---
id: service-operations
title: 'Service Operations Contract'
kind: reference
version: '1.0.0'
last_updated: '2026-07-28'
last_verified: '2026-07-28'
review_cadence_days: 30
status: stable
tags: [reference, infrastructure, operations, health, recovery]
---

# Service Operations Contract

This page is generated from `governance/service-operations.json`. CI verifies
that all seven released services have a non-root, digest-pinned container with a
real health check and that checked-in application workloads retain startup,
readiness, liveness, resources, seccomp, dropped capabilities, a read-only root
filesystem, and secret indirection.

## Runtime endpoints

| Service | Port contract | Liveness | Readiness | Operations |
|---|---|---|---|---|
| `chaintracks-server` | PORT (default 3011; CDN is port + 1) | `/getInfo` | `/getInfo` | [guide](../infrastructure/chaintracks-server.md) |
| `message-box-server` | PORT, then HTTP_PORT (default 8080) | `/health` | `/ready` | [guide](https://github.com/bsv-blockchain/ts-stack/blob/main/infra/message-box-server/DEPLOYING.md) |
| `overlay-server` | 8080 | `/health/live` | `/health/ready` | [guide](https://github.com/bsv-blockchain/ts-stack/blob/main/infra/overlay-server/deploy/README.md) |
| `uhrp-server-basic` | HTTP_PORT (default 8080) | `/health` | `/ready` | [guide](../infrastructure/uhrp-server-basic.md) |
| `uhrp-server-cloud-bucket` | HTTP_PORT (default 8080) | `/health` | `/ready` | [guide](../infrastructure/uhrp-server-cloud-bucket.md) |
| `wab` | PORT (default 8080) | `/info` | `/info` | [guide](https://github.com/bsv-blockchain/ts-stack/blob/main/infra/wab/deploy/README.md) |
| `wallet-infra` | HTTP_PORT (default 8081; samples set 8080 without nginx) | `/` | `/` | [guide](https://github.com/bsv-blockchain/ts-stack/blob/main/infra/wallet-infra/guides/kube_samples/README.md) |

Health endpoints are public and non-sensitive. They do not replace protocol
authentication or rate limits. Public services retain wildcard,
credential-free CORS by default; CSP remains a separate document/UI policy.

## State, migration, and recovery

### chaintracks-server

- State: Bulk-header files under BULK_HEADERS_PATH; upstream headers are reproducible.
- Migration/startup: No schema migration. Validate the retained header corpus before rollout.
- Backup/restore: Snapshot BULK_HEADERS_PATH or repopulate it from a verified source CDN.
- Operator guide: [docs/infrastructure/chaintracks-server.md](../infrastructure/chaintracks-server.md)

### message-box-server

- State: Knex database plus optional Firebase device registrations.
- Migration/startup: Migrations complete before listen; back up and verify the target schema first.
- Backup/restore: Use the selected database engine's consistent snapshot and restore procedure.
- Operator guide: [infra/message-box-server/DEPLOYING.md](https://github.com/bsv-blockchain/ts-stack/blob/main/infra/message-box-server/DEPLOYING.md)

### overlay-server

- State: Knex transaction state and MongoDB lookup-service state.
- Migration/startup: Overlay migrations complete before listen; preserve both stores as one release boundary.
- Backup/restore: Take coordinated MySQL and MongoDB backups before schema or image changes.
- Operator guide: [infra/overlay-server/deploy/README.md](https://github.com/bsv-blockchain/ts-stack/blob/main/infra/overlay-server/deploy/README.md)

### uhrp-server-basic

- State: Local files and metadata under the configured public storage directory.
- Migration/startup: No schema migration; preserve file and metadata consistency.
- Backup/restore: Snapshot the complete storage directory and verify hashes before restore.
- Operator guide: [docs/infrastructure/uhrp-server-basic.md](../infrastructure/uhrp-server-basic.md)

### uhrp-server-cloud-bucket

- State: Cloud bucket objects and provider metadata.
- Migration/startup: No local schema migration; validate provider configuration before listen.
- Backup/restore: Use provider versioning/replication and verify object hashes and retention policy.
- Operator guide: [docs/infrastructure/uhrp-server-cloud-bucket.md](../infrastructure/uhrp-server-cloud-bucket.md)

### wab

- State: Authentication, identity-link, share, deletion-intent, and faucet database tables.
- Migration/startup: Migrations complete before listen; verify rollback compatibility before rollout.
- Backup/restore: Take an encrypted database snapshot and test identity/share recovery without logging secrets.
- Operator guide: [infra/wab/deploy/README.md](https://github.com/bsv-blockchain/ts-stack/blob/main/infra/wab/deploy/README.md)

### wallet-infra

- State: Wallet Storage database, monitor state, transactions, outputs, baskets, and certificates.
- Migration/startup: Storage migration and availability checks complete before the server starts.
- Backup/restore: Take and verify a consistent database backup before every schema or image change.
- Operator guide: [infra/wallet-infra/guides/kube_samples/README.md](https://github.com/bsv-blockchain/ts-stack/blob/main/infra/wallet-infra/guides/kube_samples/README.md)

## Change procedure

1. Change a service, Dockerfile, manifest, or operator guide.
2. Update `governance/service-operations.json` when the operational contract changes.
3. Run `pnpm ops:docs`, then `pnpm ops:check`.
4. Run the affected service tests and the full repository health, container,
   documentation, security, and merge gates.
5. Deploy only through a separately authorized release and record the exact image
   digest, probe evidence, migration result, backup, and rollback outcome.
