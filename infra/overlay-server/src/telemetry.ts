/**
 * OpenTelemetry bootstrap — preloaded before app code via `node --require ./dist/telemetry.js`.
 *
 * Emits traces, metrics and logs. All wiring is driven by OTEL_* env vars; when
 * OTEL_EXPORTER_OTLP_ENDPOINT is unset we fall back to console exporters so the
 * process always boots (dev-safe). Runtime (heap/GC/event-loop) metrics are
 * enabled to support memory-leak diagnosis.
 *
 * This file is intentionally self-contained and identical across infra
 * components (see docs/superpowers/specs/2026-06-22-infra-opentelemetry-design.md).
 */
import { NodeSDK } from '@opentelemetry/sdk-node'
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'
import { RuntimeNodeInstrumentation } from '@opentelemetry/instrumentation-runtime-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http'
import {
    ConsoleSpanExporter,
    BatchSpanProcessor,
    SimpleSpanProcessor,
    type SpanExporter,
} from '@opentelemetry/sdk-trace-base'
import {
    PeriodicExportingMetricReader,
    ConsoleMetricExporter,
    type PushMetricExporter,
} from '@opentelemetry/sdk-metrics'
import {
    BatchLogRecordProcessor,
    SimpleLogRecordProcessor,
    ConsoleLogRecordExporter,
    type LogRecordExporter,
} from '@opentelemetry/sdk-logs'
import { resourceFromAttributes } from '@opentelemetry/resources'
import {
    ATTR_SERVICE_NAME,
    ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions'
import { logs, SeverityNumber } from '@opentelemetry/api-logs'
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require('../package.json') as { name: string; version: string }

const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
const useOtlp = typeof otlpEndpoint === 'string' && otlpEndpoint.length > 0
const env = process.env.DEPLOY_ENV ?? process.env.NODE_ENV ?? 'development'

if (process.env.OTEL_DIAG === 'true') {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO)
}

const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? pkg.name,
    [ATTR_SERVICE_VERSION]: pkg.version,
    'deployment.environment': env,
})

const traceExporter: SpanExporter = useOtlp
    ? new OTLPTraceExporter()
    : new ConsoleSpanExporter()
const metricExporter: PushMetricExporter = useOtlp
    ? new OTLPMetricExporter()
    : new ConsoleMetricExporter()
const logExporter: LogRecordExporter = useOtlp
    ? new OTLPLogExporter()
    : new ConsoleLogRecordExporter()

const logRecordProcessor = useOtlp
    ? new BatchLogRecordProcessor(logExporter)
    : new SimpleLogRecordProcessor(logExporter)

const sdk = new NodeSDK({
    resource,
    spanProcessors: [
        useOtlp
            ? new BatchSpanProcessor(traceExporter)
            : new SimpleSpanProcessor(traceExporter),
    ],
    metricReader: new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: Number(process.env.OTEL_METRIC_EXPORT_INTERVAL ?? 60000),
    }),
    logRecordProcessors: [logRecordProcessor],
    instrumentations: [
        getNodeAutoInstrumentations({
            // Filesystem spans are pure noise for these servers.
            '@opentelemetry/instrumentation-fs': { enabled: false },
        }),
        // Heap / GC / event-loop lag — the primary memory-leak signal.
        new RuntimeNodeInstrumentation(),
    ],
})

sdk.start()

// Capture clean console refs before patching, for telemetry's own messages.
const rawInfo = console.info.bind(console)
const rawError = console.error.bind(console)

// Bridge stray console.* calls into OTel logs so nothing is lost while code is
// migrated to the structured (pino) logger. Trace context is attached
// automatically by the logs SDK.
const logger = logs.getLogger(pkg.name, pkg.version)
const SEVERITY: Record<string, SeverityNumber> = {
    debug: SeverityNumber.DEBUG,
    info: SeverityNumber.INFO,
    log: SeverityNumber.INFO,
    warn: SeverityNumber.WARN,
    error: SeverityNumber.ERROR,
}
for (const method of ['debug', 'info', 'log', 'warn', 'error'] as const) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const original = (console as any)[method].bind(console)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(console as any)[method] = (...args: any[]) => {
        try {
            logger.emit({
                severityNumber: SEVERITY[method],
                severityText: method.toUpperCase(),
                body: args
                    .map((a) =>
                        typeof a === 'string' ? a : (() => {
                            try { return JSON.stringify(a) } catch { return String(a) }
                        })()
                    )
                    .join(' '),
            })
        } catch {
            /* never let telemetry break logging */
        }
        original(...args)
    }
}

const shutdown = (signal: string) => {
    sdk.shutdown()
        .then(() => rawInfo(`[otel] shutdown complete (${signal})`))
        .catch((err: unknown) => rawError('[otel] shutdown error', err))
        .finally(() => process.exit(0))
}
process.once('SIGTERM', () => shutdown('SIGTERM'))
process.once('SIGINT', () => shutdown('SIGINT'))
