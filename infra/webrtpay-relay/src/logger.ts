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
import type { LoggerOptions } from 'pino'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Keys whose values never leave the process, at the top level and one or two levels down. */
const SECRET_KEYS = ['secret', 'apiToken', 'token', 'authorization']
const SECRET_ENV = ['TURN_SECRET', 'CLOUDFLARE_TURN_API_TOKEN']

function redactPaths(): string[] {
  const nested = SECRET_KEYS.flatMap(key => [`*.${key}`, `*.*.${key}`])
  return [...SECRET_KEYS, ...SECRET_ENV, ...nested]
}

function packageName(): string {
  const raw = readFileSync(join(process.cwd(), 'package.json'), 'utf8')
  return (JSON.parse(raw) as { name: string }).name
}

function loggerOptions(name: string, env: NodeJS.ProcessEnv): LoggerOptions {
  return {
    name,
    level: env.LOG_LEVEL ?? 'info',
    base: {
      service: env.OTEL_SERVICE_NAME ?? name,
      env: env.DEPLOY_ENV ?? env.NODE_ENV ?? 'development'
    },
    redact: { paths: redactPaths(), censor: '[redacted]' },
    formatters: { level: label => ({ level: label }) }
  }
}

export const log = pino(loggerOptions(packageName(), process.env))
