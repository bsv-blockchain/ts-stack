/**
 * Structured application logger (pino).
 *
 * Emits leveled JSON with stable field names so logs are queryable across infra
 * components and correlate to traces: @opentelemetry/instrumentation-pino (loaded
 * by telemetry.ts) injects trace_id/span_id into every record, and the records
 * are shipped to the OTLP logs endpoint.
 *
 * Stable keys: service, env, operation, outcome ('ok'|'error'), duration_ms,
 * plus err. Domain keys are namespaced per call site.
 */
import pino from 'pino'
import packageJson from '../package.json'

export const log = pino({
    name: packageJson.name,
    level: process.env.LOG_LEVEL ?? 'info',
    base: {
        service: process.env.OTEL_SERVICE_NAME ?? packageJson.name,
        env: process.env.DEPLOY_ENV ?? process.env.NODE_ENV ?? 'development',
    },
    formatters: {
        // Emit `level` as its text name (info/warn/error) rather than a number.
        level: (label) => ({ level: label }),
    },
})
