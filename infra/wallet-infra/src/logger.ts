/**
 * Structured application logger (pino).
 *
 * Leveled JSON with stable field names, correlated to traces via
 * @opentelemetry/instrumentation-pino (loaded by telemetry.ts) and shipped to
 * the OTLP logs endpoint. Stable keys: service, env, operation, outcome, err.
 */
import pino from 'pino'
import pkg from '../package.json' with { type: 'json' }

export const log = pino({
    name: pkg.name,
    level: process.env.LOG_LEVEL ?? 'info',
    base: {
        service: process.env.OTEL_SERVICE_NAME ?? pkg.name,
        env: process.env.DEPLOY_ENV ?? process.env.NODE_ENV ?? 'development',
    },
    formatters: {
        level: (label) => ({ level: label }),
    },
})
