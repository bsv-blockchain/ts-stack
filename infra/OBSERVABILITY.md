# Infra Observability (OpenTelemetry)

Every infra component emits OpenTelemetry **traces, metrics and logs**. Each
component has a self-contained bootstrap (`src/telemetry.ts`) that is preloaded
before application code so auto-instrumentation can patch modules before they
are imported.

## Components

| Component | Module | Preload |
|---|---|---|
| overlay-server | ESM | `node --import ./dist/telemetry.js dist/index.js` |
| chaintracks-server | CJS | `node --require ./dist/telemetry.js dist/server.js` |
| wab | CJS | `node --require ./dist/telemetry.js dist/server.js` |
| uhrp-server-cloud-bucket | CJS | `node --require ./out/src/telemetry.js … out/src/index.js` |
| uhrp-server-basic | CJS | `ts-node -r ./src/telemetry.ts src/index.ts` / `start:prod` |
| wallet-infra | ESM | `node --import ./out/src/telemetry.js out/src/index.js` |
| message-box-server | ESM | `node --import ./out/src/telemetry.js out/src/index.js` |

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

| Variable | Purpose | Default |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP/HTTP collector base URL. **Unset → console exporters** (dev-safe). | — |
| `OTEL_EXPORTER_OTLP_HEADERS` | Comma-separated headers, e.g. auth for Coralogix. | — |
| `OTEL_SERVICE_NAME` | Overrides `service.name` (defaults to the package name). | package name |
| `OTEL_RESOURCE_ATTRIBUTES` | Extra resource attributes. | — |
| `DEPLOY_ENV` / `NODE_ENV` | Becomes `deployment.environment`. | `development` |
| `OTEL_METRIC_EXPORT_INTERVAL` | Metric export interval (ms). | `60000` |
| `OTEL_DIAG` | `true` enables OTel internal diagnostic logging. | off |
| `LOG_LEVEL` | pino log level. | `info` |

Point the whole stack at a collector by exporting once, e.g.:

```sh
export OTEL_EXPORTER_OTLP_ENDPOINT="https://ingress.<region>.coralogix.com"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <key>"
docker compose up
```

With the endpoint **unset**, each service prints spans/metrics/logs to the
console — useful for verifying instrumentation locally without a backend.

## Signals

- **Traces** — HTTP, Express, MongoDB, MySQL/Knex, DNS auto-instrumentation, plus
  a `*.bootstrap` span per service wrapping startup.
- **Metrics** — HTTP server/client metrics, and **runtime metrics**
  (`nodejs.eventloop.*`, `v8js.memory.heap.*`, GC) via
  `@opentelemetry/instrumentation-runtime-node`. These are the primary signal for
  **memory-leak and event-loop diagnosis**.
- **Logs** — structured JSON via **pino** (`src/logger.ts`), with `trace_id` /
  `span_id` injected by `@opentelemetry/instrumentation-pino` so logs correlate to
  traces, shipped over OTLP. Stray `console.*` calls are also bridged to OTel logs
  during the migration to structured logging.

### Structured logging conventions

Use stable field names so queries work across services:
`service`, `env`, `operation`, `outcome` (`ok` | `error`), `duration_ms`, `err`,
plus domain-specific keys. Example:

```ts
import { log } from './logger'
log.info({ operation: 'listen', outcome: 'ok', port }, 'server listening')
```

## Notes

- Telemetry shutdown flushes the SDK on `SIGTERM`/`SIGINT` and only force-exits
  when the app has no signal handler of its own (e.g. chaintracks owns its
  lifecycle), so it never preempts application cleanup.
- Adding telemetry introduced no new dependency CVEs; pre-existing transitive
  advisories (e.g. message-box `firebase-admin → @google-cloud/storage`) are
  unrelated.

See the design spec: `docs/superpowers/specs/2026-06-22-infra-opentelemetry-design.md`.
