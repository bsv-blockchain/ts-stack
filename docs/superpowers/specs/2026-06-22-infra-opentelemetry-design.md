---
id: infra-opentelemetry-design
title: Infra OpenTelemetry & Structured Logging — Design
kind: spec
domain: infra
version: 1.0.0
last_updated: "2026-06-22"
last_verified: "2026-06-22"
status: experimental
tags:
  - opentelemetry
  - observability
  - infra
  - logging
---

# Infra OpenTelemetry & Structured Logging — Design

**Date:** 2026-06-22
**Goal:** Every infra component in the stack produces OpenTelemetry (traces, metrics, logs) to improve observability — specifically to find bugs faster and diagnose memory leaks / resource issues.

## Scope

Seven standalone infra components (each its own npm project — own `package-lock.json`, **not** in the pnpm workspace):

| Component | Pkg name | Module | Build dir | Entry | Notes |
|---|---|---|---|---|---|
| overlay-server | `@bsv/overlay-express-examples` | CJS | `dist/` | `dist/index.ts` | Express owned by `@bsv/overlay-express`; Mongo + MySQL/Knex. **Reference impl.** |
| wallet-infra | `@bsv/wallet-infra` | **ESM** | `out/` | `out/src/index.js` | Express; nginx front |
| message-box-server | `@bsv/messagebox-server` | **ESM** | `out/` | `out/src/index.js` | Express + auth/payment middleware; nginx |
| chaintracks-server | `chaintracks-server` | CJS | `dist/` | `dist/server.js` | Express |
| uhrp-server-cloud-bucket | `@bsv/uhrp-storage-server` | CJS | `out/` | `out/src/index.js` | Express + Bugsnag; notifier sidecar |
| uhrp-server-basic | `@bsv/uhrp-lite` | CJS | `out/` | `out/src/index.js` | Express; **no Dockerfile** |
| wab | `@bsv/wab-server` | CJS | `dist/` | `dist/server.js` | Express + rate-limit |

Rollout order (fixed by user): **overlay-server → wallet-infra → message-box-server → chaintracks-server → uhrp-server-cloud-bucket → uhrp-server-basic → wab**.

## Decisions (locked)

- **Exporter:** OTLP/HTTP, all config from `OTEL_*` env. No vendor hardcoding (backend is OTLP-compatible, e.g. Coralogix collector). Endpoint unset → console exporters so boot never breaks in dev.
- **Signals:** Traces + Metrics + Logs.
- **Load:** Preload before app code. CJS → `node --require ./<out>/telemetry.js`; ESM → `node --import ./<out>/telemetry.mjs`. Guarantees auto-instrumentation patches modules before import.
- **Duplication:** Each component owns its `src/telemetry.ts` (identical content, compiled by existing `tsc`). No generator.
- **Structured logging:** Adopt **pino** as the structured logger, replacing ad-hoc `console.log`. `@opentelemetry/instrumentation-pino` auto-injects `trace_id`/`span_id` so logs correlate to spans. A console→OTel log shim stays as a fallback for un-converted call sites.

## Architecture

### Per-component telemetry bootstrap (`src/telemetry.ts`)

Starts a `NodeSDK` (`@opentelemetry/sdk-node`) with:

- **Resource**: `service.name` (= package name, overridable via `OTEL_SERVICE_NAME`), `service.version` (= package version), `deployment.environment` (from `DEPLOY_ENV`/`NODE_ENV`, default `development`). Correct even with zero env set.
- **Auto-instrumentation**: `getNodeAutoInstrumentations()` — HTTP, Express, Mongo/Mongoose, MySQL2, DNS, net, pino. Filesystem instrumentation disabled (noise).
- **Runtime metrics**: `@opentelemetry/instrumentation-runtime-node` — heap used/total, GC pause/count, event-loop lag, active handles. **This is the primary memory-leak signal.**
- **Exporters** (chosen at runtime by presence of `OTEL_EXPORTER_OTLP_ENDPOINT`):
  - set → OTLP/HTTP trace + metric (PeriodicExportingMetricReader) + logs exporters.
  - unset → `ConsoleSpanExporter` / console metric + log exporters.
- **Logs**: `LoggerProvider` with OTLP (or console) `BatchLogRecordProcessor`; console→OTel shim patches `console.*` to also emit log records at mapped severities.
- **Graceful shutdown**: `SIGTERM`/`SIGINT` → `sdk.shutdown()` to flush before exit.

### Deps added per component (`@opentelemetry/…`)

`sdk-node`, `auto-instrumentations-node`, `instrumentation-runtime-node`, `exporter-trace-otlp-http`, `exporter-metrics-otlp-http`, `exporter-logs-otlp-http`, `resources`, `semantic-conventions`, `api-logs`, plus `pino`.

### Dockerfile / compose changes

- `CMD` gains the preload flag (`--require`/`--import` per module type).
- `docker-compose.yml` passes through `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`, `DEPLOY_ENV`.
- uhrp-server-basic has no Dockerfile → preload added to `start`/`dev` scripts via `NODE_OPTIONS` or `--require`.

## Per-component phases

Each component goes through three phases; depth of B/C scales with the component:

- **Phase A — Bootstrap:** add deps, `telemetry.ts`, preload wiring, compose env. Signals flow from auto-instrumentation + runtime metrics. Build verifies clean.
- **Phase B — Structured logging:** audit existing log sites, replace `console.*` with a pino logger emitting leveled, structured events with **stable field names** (`service`, `operation`, `duration_ms`, plus domain fields like `tx_id`, `topic`, `host`). Drop noisy/duplicate logs; promote silent failures to logged events.
- **Phase C — Domain spans/metrics:** wrap the operations that matter (overlay submit/lookup, wallet storage calls, message send/ack, header sync) in spans with attributes, and add a few custom counters/histograms where a bug or leak would show up.

overlay-server (reference) gets A+B+C fully, establishing the template; later components reuse its `telemetry.ts` verbatim and apply B/C proportional to their surface.

## Field-name conventions (structured logs)

Stable keys so queries work across services: `service`, `env`, `operation`, `outcome` (`ok`|`error`), `duration_ms`, `error.type`, `error.msg`, plus OTel-injected `trace_id`/`span_id`. Domain keys namespaced per component.

## Testing / verification

- Each component: `npm run build` clean; boot locally with `OTEL_EXPORTER_OTLP_ENDPOINT` unset → console spans/metrics/logs visible; boot with a local OTLP collector → spans/metrics/logs received.
- No new lint errors. Memory-leak signal confirmed by observing `runtime.node.memory.heap.used` + GC metrics in console/collector.
- Per release-flow memory: patch-bump only own `version` field; do not run sync-versions; user builds + tests the Docker image locally before any push.

## Out of scope

- Choosing/standing up the collector or backend (env-driven; user supplies endpoint).
- Distributed-trace context propagation across components beyond what auto-instrumentation provides via HTTP headers (W3C tracecontext is on by default).
- Dashboards/alerts (separate effort; Coralogix CLI skills available later).
