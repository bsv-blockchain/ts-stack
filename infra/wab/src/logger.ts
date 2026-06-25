/**
 * Structured application logger (pino).
 *
 * Leveled JSON with stable field names, correlated to traces via
 * @opentelemetry/instrumentation-pino (loaded by telemetry.ts) and shipped to
 * the OTLP logs endpoint. Stable keys: service, env, operation, outcome, err.
 */
import pino from 'pino'
import * as path from 'node:path'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require(path.join(process.cwd(), 'package.json')) as { name: string; version: string }

export const log = pino({
    name: pkg.name,
    level: process.env.LOG_LEVEL ?? 'info',
    base: {
        service: process.env.OTEL_SERVICE_NAME ?? pkg.name,
        env: process.env.DEPLOY_ENV ?? process.env.NODE_ENV ?? 'development',
    },
    // Scrub PII / credentials before records leave the process. on-chain data
    // (identity_key, txid) is public and intentionally NOT redacted.
    redact: {
        paths: [
            'phone', 'phoneNumber', 'identifier',
            'presentation_key', 'presentationKey', 'payload', 'store',
            'password', 'pass', 'secret', 'privateKey', 'private_key',
            'authorization', 'token', 'access_token',
            '*.phone', '*.phoneNumber', '*.identifier', '*.authorization',
        ],
        censor: '[redacted]',
    },
    formatters: {
        level: (label) => ({ level: label }),
    },
})
