/**
 * Structured application logger (pino).
 *
 * Leveled JSON with stable field names, correlated to traces via
 * @opentelemetry/instrumentation-pino (loaded by telemetry.ts) and shipped to
 * the OTLP logs endpoint. Stable keys: service, env, operation, outcome, err.
 * The relay never logs signalling payloads, and its TURN secrets are redacted
 * here as well should a record ever carry them.
 */
import pino from 'pino'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
  name: string
  version: string
}

export const log = pino({
  name: pkg.name,
  level: process.env.LOG_LEVEL ?? 'info',
  base: {
    service: process.env.OTEL_SERVICE_NAME ?? pkg.name,
    env: process.env.DEPLOY_ENV ?? process.env.NODE_ENV ?? 'development'
  },
  redact: {
    paths: [
      'secret',
      'apiToken',
      'token',
      'authorization',
      'TURN_SECRET',
      'CLOUDFLARE_TURN_API_TOKEN',
      '*.secret',
      '*.apiToken',
      '*.authorization'
    ],
    censor: '[redacted]'
  },
  formatters: {
    level: label => ({ level: label })
  }
})
