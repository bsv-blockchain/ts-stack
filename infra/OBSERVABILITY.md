# Infra Observability (OpenTelemetry)

Every infra component supports OpenTelemetry **traces, metrics and logs**. Each
component has a self-contained bootstrap (`src/telemetry.ts`) that is preloaded
before application code so auto-instrumentation can patch modules before they
are imported.

## Components

| Component                | Module | Preload                                                     |
| ------------------------ | ------ | ----------------------------------------------------------- |
| overlay-server           | ESM    | `node --import ./dist/telemetry.js dist/index.js`           |
| chaintracks-server       | CJS    | `node --require ./dist/telemetry.js dist/server.js`         |
| wab                      | CJS    | `node --require ./dist/telemetry.js dist/server.js`         |
| uhrp-server-cloud-bucket | CJS    | `node --require ./out/src/telemetry.js … out/src/index.js`  |
| uhrp-server-basic        | CJS    | `ts-node -r ./src/telemetry.ts src/index.ts` / `start:prod` |
| wallet-infra             | ESM    | `node --import ./out/src/telemetry.js out/src/index.js`     |
| message-box-server       | ESM    | `node --import ./out/src/telemetry.js out/src/index.js`     |

ESM components (overlay-server, wallet-infra, message-box-server) deliberately do
**not** register the `import-in-the-middle` loader hook. That hook rebuilds the
named exports of CJS packages imported as ESM and drops some of them (e.g.
`@bsv/sdk`'s `PushDrop`), crashing the app at import time. The libraries we
actually instrument (http, express, mongodb, mysql2, pino) are loaded through CJS
dependency chains (overlay-express, wallet-toolbox, authsocket) and remain patched
by `require-in-the-middle`, so auto-instrumentation coverage is retained.

## Configuration

All wiring is driven by standard `OTEL_*` environment variables. The Dockerfiles
and `docker-compose.yml` files pass these through.

| Variable                      | Purpose                                                                                          | Default       |
| ----------------------------- | ------------------------------------------------------------------------------------------------ | ------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP/HTTP collector base URL. **Unset → telemetry off**, application logs stay active.           | —             |
| `OTEL_CONSOLE_EXPORTERS`      | Set exactly `true` to explicitly enable local console telemetry when no collector is configured. | `false`       |
| `OTEL_EXPORTER_OTLP_HEADERS`  | Comma-separated headers, e.g. auth for Coralogix.                                                | —             |
| `OTEL_SERVICE_NAME`           | Overrides `service.name` (defaults to the package name).                                         | package name  |
| `OTEL_RESOURCE_ATTRIBUTES`    | Extra resource attributes.                                                                       | —             |
| `DEPLOY_ENV` / `NODE_ENV`     | Becomes `deployment.environment`.                                                                | `development` |
| `OTEL_METRIC_EXPORT_INTERVAL` | Metric export interval (ms).                                                                     | `60000`       |
| `OTEL_DIAG`                   | `true` enables OTel internal diagnostic logging.                                                 | off           |
| `LOG_LEVEL`                   | pino log level.                                                                                  | `info`        |

Point the whole stack at a collector by exporting once, e.g.:

```sh
export OTEL_EXPORTER_OTLP_ENDPOINT="https://ingress.<region>.coralogix.com"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <key>"
docker compose up
```

With the endpoint **unset**, the bootstrap starts no telemetry SDK, auto-instrumentation,
export timers, console bridge or telemetry signal handlers. Application `console.*`
and structured pino logging continue normally. This is the quiet default in both
containers and development; an absent collector never silently enables console exporters.

For temporary local diagnostics, set `OTEL_CONSOLE_EXPORTERS=true`. An OTLP endpoint
takes precedence when both are configured. Console mode leaves application console
methods untouched so their messages are not duplicated through the OTel Logs API.
Remove the flag after debugging: auto-instrumentation can produce substantial output.

For production observability, configure an OTLP collector and use its filtering and
sampling controls together with `LOG_LEVEL`. To adopt the new default, configure
the collector explicitly if you relied on implicit console telemetry. Deploy the
rebuilt service images through the normal release process; merging this source
change does not change running containers.

## Signals

- **Traces** — HTTP, Express, MongoDB, MySQL/Knex, DNS auto-instrumentation, plus
  a `*.bootstrap` span per service wrapping startup.
- **Metrics** — HTTP server/client metrics, and **runtime metrics**
  (`nodejs.eventloop.*`, `v8js.memory.heap.*`, GC) via
  `@opentelemetry/instrumentation-runtime-node`. These are the primary signal for
  **memory-leak and event-loop diagnosis**.
- **Logs** — structured JSON via **pino** (`src/logger.ts`), with `trace_id` /
  `span_id` injected by `@opentelemetry/instrumentation-pino` so logs correlate to
  traces, shipped over OTLP. Stray `console.*` calls are bridged to OTel logs only in OTLP mode
  during the migration to structured logging.

### Structured logging conventions

Use stable field names so queries work across services:
`service`, `env`, `operation`, `outcome` (`ok` | `error`), `duration_ms`, `err`,
plus domain-specific keys. Example:

```ts
import { log } from './logger'
log.info({ operation: 'listen', outcome: 'ok', port }, 'server listening')
```

### Overlay operation names

Overlay deployments should preserve these `operation` names because they map to
operator alerts and dashboards:

| Operation                            | Emitted by                     | Notes                                                                                                            |
| ------------------------------------ | ------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `overlay.provider_callback`          | Overlay Express `/arc-ingest`  | Provider callback accepted, rejected, or classified as terminal/double-spend. Alert on repeated `outcome=error`. |
| `overlay.unproven_proof_refresh`     | `/admin/refreshUnprovenProofs` | Manual or monitor-triggered proof refresh for old unproven rows.                                                 |
| `overlay.unproven_eviction`          | `/admin/evictUnproven`         | Eviction-only cleanup for stale unproven rows.                                                                   |
| `overlay.unproven_maintenance`       | `/admin/maintainUnproven`      | Refresh-before-evict maintenance. This is the preferred operational path.                                        |
| `overlay.health` / HTTP health spans | health routes                  | Use readiness failures and provider context to detect bad deployment wiring.                                     |

Alerting should distinguish transient provider failures from terminal provider
classification. Terminal double-spend or invalid callbacks are expected to evict
the transaction and should be visible as a domain event, while repeated callback
processing errors mean the overlay may not be ingesting proofs or rejection
signals.

Wallet infrastructure uses the same convention. The important startup operations
are `wallet_storage.setup`, `storage.setup`, `storage_server.start`, and
`monitor.start`; task-specific wallet monitor details are also persisted as
monitor events in storage.

## Notes

- Telemetry shutdown flushes the SDK on `SIGTERM`/`SIGINT` and only force-exits
  when the app has no signal handler of its own (e.g. chaintracks owns its
  lifecycle), so it never preempts application cleanup.
- The infra projects use one aligned OpenTelemetry release family and their
  committed npm graphs pass `npm audit --audit-level=high`. Temporary
  transitive security pins and their removal criteria are documented in
  `infra/DEPENDENCY_POLICY.md`.

See the design spec: `docs/superpowers/specs/2026-06-22-infra-opentelemetry-design.md`.

## Bootstrap source ownership

`infra/overlay-server/src/telemetry.ts` is the canonical bootstrap. The other six
standalone service build contexts receive identical copies through
`pnpm sync:service-runtime-copies`; repository health rejects drift. The same
source compiles as ESM or CommonJS and reads package metadata from the service
working directory. Only the six synchronized copies are excluded from Sonar
duplication scoring; code analysis and the shared bootstrap behavior tests remain
active. Edit the canonical source, synchronize, and validate all service builds.
