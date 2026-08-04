---
id: service-operations
title: 'Service Operations Contract'
kind: reference
version: '2.0.0'
last_updated: '2026-08-04'
last_verified: '2026-08-04'
review_cadence_days: 30
status: stable
tags: [reference, infrastructure, operations, observability, slo, recovery]
---

# Service Operations Contract

This page is generated from `governance/service-operations.json`. CI verifies
all seven released services against their configuration, secret, telemetry,
container, health, lifecycle, recovery, and checked-in workload contracts.

## Public service boundary

These are public protocol services used by deployed applications, wallets,
webviews, mobile devices, opaque origins, and callers that are not known ahead
of time. Credential-free wildcard CORS is therefore the default. Exact-origin
allowlists are opt-in, cookie credentials are not enabled with wildcard origins,
and CSP remains an independent document/UI policy rather than API authorization.

## Runtime endpoints and lifecycle

| Service                    | Port contract                                            | Liveness   | Readiness       | Lifecycle   | Operations                                                                                                     |
| -------------------------- | -------------------------------------------------------- | ---------- | --------------- | ----------- | -------------------------------------------------------------------------------------------------------------- |
| `chaintracks-server`       | PORT (default 3011; CDN is port + 1)                     | `/healthz` | `/getInfo`      | implemented | [guide](../infrastructure/chaintracks-server.md)                                                               |
| `message-box-server`       | PORT, then HTTP_PORT (default 8080)                      | `/healthz` | `/ready`        | implemented | [guide](https://github.com/bsv-blockchain/ts-stack/blob/main/infra/message-box-server/DEPLOYING.md)            |
| `overlay-server`           | 8080                                                     | `/healthz` | `/health/ready` | implemented | [guide](https://github.com/bsv-blockchain/ts-stack/blob/main/infra/overlay-server/deploy/README.md)            |
| `uhrp-server-basic`        | HTTP_PORT (default 8080)                                 | `/healthz` | `/ready`        | implemented | [guide](../infrastructure/uhrp-server-basic.md)                                                                |
| `uhrp-server-cloud-bucket` | HTTP_PORT (default 8080)                                 | `/healthz` | `/ready`        | implemented | [guide](../infrastructure/uhrp-server-cloud-bucket.md)                                                         |
| `wab`                      | PORT (default 8080)                                      | `/healthz` | `/info`         | implemented | [guide](https://github.com/bsv-blockchain/ts-stack/blob/main/infra/wab/deploy/README.md)                       |
| `wallet-infra`             | HTTP_PORT (default 8081; samples set 8080 without nginx) | `/healthz` | `/`             | implemented | [guide](https://github.com/bsv-blockchain/ts-stack/blob/main/infra/wallet-infra/guides/kube_samples/README.md) |

Health endpoints are public and non-sensitive. They do not replace protocol
authentication, administrative authorization, rate limits, or dependency-aware
critical-journey monitoring.

## Observability contract

Each standalone service retains a self-contained bootstrap because infrastructure build contexts cannot safely depend on an unpublished shared runtime package. CI enforces one behavioral and dependency contract across those bootstraps.

Every service preloads telemetry before application imports and emits
traces, metrics, logs, runtime-metrics. Structured logs use
`service`, `env`, `operation`, `outcome`, `duration_ms`, `err` and correlate through
`trace_id`, `span_id`. Every environment
example documents `DEPLOY_ENV`, `LOG_LEVEL`, `OTEL_DIAG`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_METRIC_EXPORT_INTERVAL`, `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_SERVICE_NAME`;
`OTEL_EXPORTER_OTLP_HEADERS` is secret-bearing.

| Dependency                                    | Aligned direct range |
| --------------------------------------------- | -------------------- |
| `@opentelemetry/api`                          | `^1.9.1`             |
| `@opentelemetry/api-logs`                     | `^0.221.0`           |
| `@opentelemetry/auto-instrumentations-node`   | `^0.79.0`            |
| `@opentelemetry/exporter-logs-otlp-http`      | `^0.221.0`           |
| `@opentelemetry/exporter-metrics-otlp-http`   | `^0.221.0`           |
| `@opentelemetry/exporter-trace-otlp-http`     | `^0.221.0`           |
| `@opentelemetry/instrumentation-runtime-node` | `^0.34.0`            |
| `@opentelemetry/resources`                    | `^2.10.0`            |
| `@opentelemetry/sdk-logs`                     | `^0.221.0`           |
| `@opentelemetry/sdk-metrics`                  | `^2.10.0`            |
| `@opentelemetry/sdk-node`                     | `^0.221.0`           |
| `@opentelemetry/sdk-trace-base`               | `^2.10.0`            |
| `@opentelemetry/semantic-conventions`         | `^1.43.0`            |
| `pino`                                        | `^10.3.1`            |

ESM services intentionally avoid the `import-in-the-middle` loader hook because
it can remove named exports from CommonJS dependencies imported as ESM. HTTP,
Express, database, and pino instrumentation remain patched through their
CommonJS dependency chains. This is a documented compatibility boundary, not an
untracked version fork.

## Reliability, dashboards, and incidents

Operator starting points, not claims about an undeployed environment. Every production deployment must adopt them or record a measured, reviewed override.

- Availability: Start at 99.9% successful readiness-eligible protocol requests per rolling 30 days, excluding approved maintenance.
- Error budget: Page when server-side failures or failed critical journeys consume 10% of the monthly error budget in one hour or 5% in six hours.
- Latency: Define route- and payload-class p95/p99 objectives from production baselines; never combine small JSON calls with uploads, downloads, sync, or batch traffic.
- Required dashboard panels:
- request rate, status class, and duration by route and payload class
- readiness and dependency-check state
- event-loop delay, heap, garbage collection, CPU, and memory
- database pool saturation, query latency, and migration state
- rate-limit, concurrency-limit, timeout, and body-limit rejections
- trace-linked structured errors by operation and deployment version
- backup age, restore-test age, replica health, and storage capacity

Incident handling follows this evidence-preserving sequence:

1. Detect from readiness, error-budget, latency, saturation, security, and backup alerts.
2. Triage with deployment version, correlated trace and log fields, dependency health, and recent migration evidence.
3. Contain by stopping rollout, removing readiness, restricting administrative paths, or reverting only when persistence compatibility is known.
4. Recover from a verified image and backup or reproducible source; never improvise schema rollback on live state.
5. Verify protocol critical journeys, dependency health, telemetry delivery, and data integrity before resolving.
6. Record impact, timeline, cause, corrective actions, evidence, and tracker follow-ups without secrets.

## Service configuration, critical journeys, and recovery

### chaintracks-server

- Configuration: required `CHAIN`; optional
  `BULK_HEADERS_PATH`, `CDN_HOST_URL`, `ENABLE_BULK_HEADERS_CDN`, `PORT`, `SOURCE_CDN_URL`, `WHATSONCHAIN_API_KEY`; secret-bearing
  `OTEL_EXPORTER_OTLP_HEADERS`, `WHATSONCHAIN_API_KEY`.
- Telemetry: CJS bootstrap
  `src/telemetry.ts`, logger
  `src/logger.ts`, preload
  `--require ./dist/telemetry.js`.
- Critical journeys:
- return current chain information
- serve a bounded bulk-header object
- ingest and persist a verified header
- Alerts:
- header tip age or height stops advancing
- bulk-header export or upstream retrieval repeatedly fails
- API or CDN saturation exceeds its independent concurrency budget
- State: Bulk-header files under BULK_HEADERS_PATH; upstream headers are reproducible.
- Migration/startup: No schema migration. Validate the retained header corpus before rollout.
- Backup/restore: Snapshot BULK_HEADERS_PATH or repopulate it from a verified source CDN.
- RPO starting point: 24 hours when reproducible upstreams are healthy; otherwise match the operator's header-retention risk.
- RTO starting point: 4 hours from a verified snapshot or reproducible upstream.
- Restore validation: Verify header-chain continuity, tip agreement, bulk-object hashes, and both HTTP listeners.
- Lifecycle status: **implemented** — SIGTERM/SIGINT stop ingestion and export timers, drain API and CDN listeners, destroy Chaintracks state, and flush telemetry.
- Scaling: Prefer one ingest leader; CDN readers may scale only against shared immutable storage.
- Disruption: Preserve the ingest leader or use an explicit handoff during voluntary disruption.
- Topology: Separate replicated CDN readers from the ingest leader when availability requires it.
- Operator guide:
  [docs/infrastructure/chaintracks-server.md](../infrastructure/chaintracks-server.md)

### message-box-server

- Configuration: required `SERVER_PRIVATE_KEY`, `WALLET_STORAGE_URL`; optional
  `BSV_NETWORK`, `ENABLE_FIREBASE`, `ENABLE_WEBSOCKETS`, `FIREBASE_PROJECT_ID`, `FIREBASE_SERVICE_ACCOUNT_JSON`, `FIREBASE_SERVICE_ACCOUNT_PATH`, `HOSTING_DOMAIN`, `PORT`, `ROUTING_PREFIX`; secret-bearing
  `FIREBASE_SERVICE_ACCOUNT_JSON`, `OTEL_EXPORTER_OTLP_HEADERS`, `SERVER_PRIVATE_KEY`.
- Telemetry: ESM bootstrap
  `src/telemetry.ts`, logger
  `src/utils/logger.ts`, preload
  `--import ./out/src/telemetry.js`.
- Critical journeys:
- authenticate a peer and list messages
- persist and deliver a message once
- acknowledge a delivered message
- establish and use an authenticated WebSocket
- Alerts:
- message persistence succeeds but delivery or acknowledgement repeatedly fails
- authenticated WebSocket handshakes or delivery failures spike
- wallet storage, database, or Firebase dependency failures consume error budget
- State: Knex database plus optional Firebase device registrations.
- Migration/startup: Migrations complete before listen; back up and verify the target schema first.
- Backup/restore: Use the selected database engine's consistent snapshot and restore procedure.
- RPO starting point: 15 minutes for messages and permissions; device registrations follow the same backup boundary when enabled.
- RTO starting point: 4 hours from a verified database backup and wallet configuration.
- Restore validation: Verify migration state, authenticated list/send/acknowledge, duplicate handling, and optional push delivery.
- Lifecycle status: **implemented** — SIGTERM/SIGINT disconnect authenticated WebSockets, drain HTTP, close Knex, and flush telemetry. The standalone compatibility adapter uses only the published AuthSocket public socket surface and automatically delegates to AuthSocketServer.close() when that API is available.
- Scaling: Multiple replicas require shared BRC-103 sessions, database-backed rate limits, and a verified WebSocket routing strategy.
- Disruption: Preserve at least one ready replica only after shared session and WebSocket behavior is proven.
- Topology: Spread replicas after shared-state requirements are met; otherwise operate as an explicit singleton.
- Operator guide:
  [infra/message-box-server/DEPLOYING.md](https://github.com/bsv-blockchain/ts-stack/blob/main/infra/message-box-server/DEPLOYING.md)

### overlay-server

- Configuration: required `HOSTING_URL`, `KNEX_URL`, `MONGO_URL`, `NETWORK`, `NODE_NAME`, `SERVER_PRIVATE_KEY`, `WALLET_STORAGE_URL`; optional
  `ADMIN_TOKEN`, `ARCADE_API_KEY`, `ARCADE_DEPLOYMENT_ID`, `ARCADE_URL`, `ARC_API_KEY`, `ARC_CALLBACK_TOKEN`, `CHAINTRACKS_URL`, `GASP_ENABLED`; secret-bearing
  `ADMIN_TOKEN`, `ARCADE_API_KEY`, `ARC_API_KEY`, `ARC_CALLBACK_TOKEN`, `KNEX_URL`, `MONGO_URL`, `OTEL_EXPORTER_OTLP_HEADERS`, `SERVER_PRIVATE_KEY`.
- Telemetry: ESM bootstrap
  `src/telemetry.ts`, logger
  `src/logger.ts`, preload
  `--import ./dist/telemetry.js`.
- Critical journeys:
- submit and propagate a transaction without creating local-only state
- query each enabled lookup service
- ingest and classify provider callbacks
- reconcile GASP/BASM state across a reorganization
- Alerts:
- readiness dependency checks fail or provider callback processing errors repeat
- unproven rows age beyond policy or maintenance repeatedly fails
- BASM tip, reorg stream, or GASP synchronization becomes stale
- State: Knex transaction state and MongoDB lookup-service state.
- Migration/startup: Overlay migrations complete before listen; preserve both stores as one release boundary.
- Backup/restore: Take coordinated MySQL and MongoDB backups before schema or image changes.
- RPO starting point: 15 minutes across a coordinated SQL and MongoDB backup boundary.
- RTO starting point: 4 hours from mutually consistent backups and verified provider configuration.
- Restore validation: Verify schema versions, topic and lookup counts, submit/lookup, provider callbacks, GASP/BASM anchors, and readiness.
- Lifecycle status: **implemented** — SIGTERM/SIGINT idempotently stop synchronization and maintenance work, drain HTTP, close Knex and MongoDB, and flush telemetry. The standalone compatibility adapter delegates to OverlayExpress.close() when available without requiring an unpublished dependency.
- Scaling: Background GASP/BASM/maintenance ownership and BRC-103 sessions must be coordinated before adding replicas.
- Disruption: Operate as a singleton unless leader election and shared sessions are proven; record a maintenance window for voluntary disruption.
- Topology: After coordination is implemented, spread ready replicas and database replicas across independent failure domains.
- Operator guide:
  [infra/overlay-server/deploy/README.md](https://github.com/bsv-blockchain/ts-stack/blob/main/infra/overlay-server/deploy/README.md)

### uhrp-server-basic

- Configuration: required `BSV_NETWORK`, `SERVER_PRIVATE_KEY`, `WALLET_STORAGE_URL`; optional
  `HOSTING_DOMAIN`, `HTTP_PORT`, `MIN_HOSTING_MINUTES`, `PRICE_PER_GB_MO`; secret-bearing
  `OTEL_EXPORTER_OTLP_HEADERS`, `SERVER_PRIVATE_KEY`.
- Telemetry: CJS bootstrap
  `src/telemetry.ts`, logger
  `src/logger.ts`, preload
  `--require ./out/src/telemetry.js`.
- Critical journeys:
- quote and authenticate an upload
- persist and retrieve content without hash drift
- renew retained content
- Alerts:
- content write, hash verification, retrieval, or renewal failures repeat
- filesystem capacity or inode headroom crosses operator thresholds
- wallet storage authentication or payment failures consume error budget
- State: Local files and metadata under the configured public storage directory.
- Migration/startup: No schema migration; preserve file and metadata consistency.
- Backup/restore: Snapshot the complete storage directory and verify hashes before restore.
- RPO starting point: 1 hour or the accepted paid-content durability window, whichever is stricter.
- RTO starting point: 4 hours from a verified filesystem snapshot and wallet configuration.
- Restore validation: Verify a sample of content hashes and metadata, upload/download/renew, wallet authentication, and capacity.
- Lifecycle status: **implemented** — SIGTERM/SIGINT remove readiness, drain HTTP, destroy the cached wallet client, and flush telemetry.
- Scaling: Use one writer unless content and metadata live on a concurrency-safe shared filesystem and rate limits are shared.
- Disruption: Protect the writer or schedule a maintenance window; never overlap independent local filesystems behind one hostname.
- Topology: Replicate only with a storage design that preserves hash-addressed consistency.
- Operator guide:
  [docs/infrastructure/uhrp-server-basic.md](../infrastructure/uhrp-server-basic.md)

### uhrp-server-cloud-bucket

- Configuration: required `BSV_NETWORK`, `GCP_BUCKET_NAME`, `GOOGLE_PROJECT_ID`, `SERVER_PRIVATE_KEY`, `WALLET_STORAGE_URL`; optional
  `GCP_STORAGE_CREDS`, `HOSTING_DOMAIN`, `HTTP_PORT`, `MIN_HOSTING_MINUTES`, `PRICE_PER_GB_MO`; secret-bearing
  `GCP_STORAGE_CREDS`, `OTEL_EXPORTER_OTLP_HEADERS`, `SERVER_PRIVATE_KEY`.
- Telemetry: CJS bootstrap
  `src/telemetry.ts`, logger
  `src/logger.ts`, preload
  `--require ./out/src/telemetry.js`.
- Critical journeys:
- quote and authenticate a cloud upload
- persist and retrieve an object without hash drift
- renew retained content
- Alerts:
- bucket authorization, write, read, metadata, or retention failures repeat
- provider quota, throttling, versioning, or replication health degrades
- wallet storage authentication or payment failures consume error budget
- State: Cloud bucket objects and provider metadata.
- Migration/startup: No local schema migration; validate provider configuration before listen.
- Backup/restore: Use provider versioning/replication and verify object hashes and retention policy.
- RPO starting point: 1 hour or the configured provider replication objective, whichever is stricter.
- RTO starting point: 4 hours from provider replicas/versioning and verified wallet configuration.
- Restore validation: Verify object hashes, metadata, retention, upload/download/renew, and provider IAM boundaries.
- Lifecycle status: **implemented** — SIGTERM/SIGINT remove readiness, drain HTTP, destroy the cached wallet client, and flush telemetry.
- Scaling: Multiple replicas require shared rate limits and a cloud provider configuration safe for concurrent writers.
- Disruption: Preserve at least one ready replica after shared rate-limit behavior is verified.
- Topology: Spread replicas independently from the bucket's own regional durability boundary.
- Operator guide:
  [docs/infrastructure/uhrp-server-cloud-bucket.md](../infrastructure/uhrp-server-cloud-bucket.md)

### wab

- Configuration: required `BSV_NETWORK`, `DB_HOST`, `DB_NAME`, `DB_PASS`, `DB_PORT`, `DB_USER`, `SERVER_PRIVATE_KEY`, `SHARE_ENCRYPTION_KEY`, `STORAGE_URL`; optional
  `COMMISSION_FEE`, `DB_CLIENT`, `PORT`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SERVICE_SID`; secret-bearing
  `DB_PASS`, `OTEL_EXPORTER_OTLP_HEADERS`, `SERVER_PRIVATE_KEY`, `SHARE_ENCRYPTION_KEY`, `TWILIO_AUTH_TOKEN`.
- Telemetry: CJS bootstrap
  `src/telemetry.ts`, logger
  `src/logger.ts`, preload
  `--require ./dist/telemetry.js`.
- Critical journeys:
- start and complete an authentication challenge
- store, retrieve, update, and delete encrypted shares
- link, unlink, and delete an identity safely
- Alerts:
- SMS challenge, completion, replay, or abuse-control failures spike
- share encryption, retrieval, or deletion failures repeat
- database migration or pool failures consume error budget
- State: Authentication, identity-link, share, deletion-intent, and faucet database tables.
- Migration/startup: Migrations complete before listen; verify rollback compatibility before rollout.
- Backup/restore: Take an encrypted database snapshot and test identity/share recovery without logging secrets.
- RPO starting point: 15 minutes for authentication and encrypted share state.
- RTO starting point: 4 hours from a verified encrypted backup and independently retained encryption keys.
- Restore validation: Verify migration state, authentication completion, share round-trip, identity links, deletion, rate limits, and audit-safe logs.
- Lifecycle status: **implemented** — SIGTERM/SIGINT drain HTTP, close Knex, and flush telemetry.
- Scaling: Multiple replicas require shared rate limits and any authentication challenge/session state to remain database-backed.
- Disruption: Preserve at least one ready replica after shared abuse-control state is verified.
- Topology: Spread ready replicas and use a highly available managed or operator-owned database.
- Operator guide:
  [infra/wab/deploy/README.md](https://github.com/bsv-blockchain/ts-stack/blob/main/infra/wab/deploy/README.md)

### wallet-infra

- Configuration: required `BSV_NETWORK`, `KNEX_DB_CONNECTION`, `SERVER_PRIVATE_KEY`; optional
  `COMMISSION_FEE`, `COMMISSION_PUBLIC_KEY`, `ENABLE_NGINX`, `FEE_MODEL`, `HTTP_PORT`, `TAAL_API_KEY`; secret-bearing
  `KNEX_DB_CONNECTION`, `OTEL_EXPORTER_OTLP_HEADERS`, `SERVER_PRIVATE_KEY`, `TAAL_API_KEY`.
- Telemetry: ESM bootstrap
  `src/telemetry.ts`, logger
  `src/logger.ts`, preload
  `--import ./out/src/telemetry.js`.
- Critical journeys:
- authenticate and execute representative storage RPC
- create and retrieve wallet state without schema drift
- run monitor tasks and advance proof state
- Alerts:
- storage RPC errors, authorization failures, or latency consume error budget
- monitor tasks stop, fail repeatedly, or proof state stops advancing
- database migration, pool saturation, or storage-capacity health degrades
- State: Wallet Storage database, monitor state, transactions, outputs, baskets, and certificates.
- Migration/startup: Storage migration and availability checks complete before the server starts.
- Backup/restore: Take and verify a consistent database backup before every schema or image change.
- RPO starting point: 15 minutes for wallet storage state.
- RTO starting point: 4 hours from a verified backup, identity key, and service-provider configuration.
- Restore validation: Verify schema and storage identity, authenticated RPC, representative wallet state, monitor progress, and provider connectivity.
- Lifecycle status: **implemented** — SIGTERM/SIGINT stop monitor tasks, terminate optional nginx, drain StorageServer, destroy wallet storage, and flush telemetry.
- Scaling: Operate one monitor leader; API replicas require shared sessions, rate limits, storage, and explicit monitor leadership.
- Disruption: Protect the monitor leader or perform an explicit handoff; preserve ready API capacity only after shared-state behavior is proven.
- Topology: Separate monitor leadership from horizontally safe API capacity when production demand justifies it.
- Operator guide:
  [infra/wallet-infra/guides/kube_samples/README.md](https://github.com/bsv-blockchain/ts-stack/blob/main/infra/wallet-infra/guides/kube_samples/README.md)

## Stateful example boundary

The checked-in database workloads are examples, not production database
architecture. They intentionally retain vendor initialization behavior rather
than receiving unsafe blanket application security settings. Production must
replace them with a managed database or an operator-owned stateful workload with
documented replication, backups, restore tests, upgrades, disruption handling,
capacity alerts, and credential rotation.

| Service          | Manifest                                              | Workload  | Classification         |
| ---------------- | ----------------------------------------------------- | --------- | ---------------------- |
| `overlay-server` | `infra/overlay-server/deploy/mysql-deployment.yaml`   | `mysql`   | example-not-production |
| `overlay-server` | `infra/overlay-server/deploy/mongodb-deployment.yaml` | `mongodb` | example-not-production |
| `wab`            | `infra/wab/deploy/mysql-deployment.yaml`              | `mysql`   | example-not-production |
| `wallet-infra`   | `infra/wallet-infra/guides/kube_samples/mysql.yaml`   | `mysql`   | example-not-production |

Application workloads retain non-root execution, RuntimeDefault seccomp, no
service-account token, dropped capabilities, read-only root filesystems, pinned
image digests, startup/readiness/liveness probes, resources, and the registered
termination grace. Production disruption, topology, and autoscaling choices must
follow the service-specific shared-state and leadership constraints above.

Hosted Linux/amd64 CI builds every governed image and requires non-root and health metadata, closed invalid-configuration behavior, successful startup, liveness, readiness after any startup-owned migration, credential-free wildcard CORS, one minimal public protocol transaction, and clean SIGTERM shutdown. Disposable MySQL, MongoDB, and source-built Wallet Infrastructure dependencies are used where the real service requires them; no image is pushed.

## Release and change procedure

1. Change a service, package, Dockerfile, manifest, configuration example, or
   operator guide.
2. Update `governance/service-operations.json` when configuration, secret,
   signal, SLO, alert, recovery, lifecycle, or deployment behavior changes.
3. Run `pnpm ops:docs`, then `pnpm ops:check`; run affected builds, tests,
   audits, package gates, and the full repository merge gates.
4. Release dependency candidates before consumers. The standalone Overlay and
   Message Box lifecycle adapters remain compatible with the current published
   dependencies and automatically delegate to their package-owned close APIs
   once those independently reviewed packages are available.
5. Deploy only through a separately authorized release. Record exact source and
   image digests, configuration and secret names, probe and critical-journey
   evidence, migration result, telemetry delivery, backup/restore evidence, and
   rollback compatibility.
