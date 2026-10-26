import pino from 'pino'
import pkg from '../../package.json' with { type: 'json' }

// Structured pino logger. @opentelemetry/instrumentation-pino (loaded by
// telemetry.ts) injects trace_id/span_id into every record, and records are
// shipped to the OTLP logs endpoint. Stable base fields: service, env.
const pinoLogger = pino({
  name: pkg.name,
  level: process.env.LOG_LEVEL ?? 'info',
  base: {
    service: process.env.OTEL_SERVICE_NAME ?? pkg.name,
    env: process.env.DEPLOY_ENV ?? process.env.NODE_ENV ?? 'development'
  },
  // Scrub common PII / credential fields before records leave the process.
  // Call sites must still use explicit allowlisted metadata because field-name
  // redaction cannot recognize every secret or correlatable identifier.
  redact: {
    paths: [
      'phone',
      'phoneNumber',
      'identifier',
      'presentation_key',
      'presentationKey',
      'payload',
      'store',
      'password',
      'pass',
      'secret',
      'privateKey',
      'private_key',
      'authorization',
      'token',
      'access_token',
      '*.phone',
      '*.phoneNumber',
      '*.identifier',
      '*.authorization'
    ],
    censor: '[redacted]'
  },
  formatters: {
    level: label => ({ level: label })
  }
})

// Export the raw pino logger for call sites that want non-sensitive structured
// fields, for example: log.info({ operation: 'send', outcome: 'ok' }, 'message delivered').
export const log = pinoLogger

// The legacy facade deliberately discards arbitrary objects at every level:
// dependency/database values can contain SQL, credentials, payloads, tokens,
// and stack paths that a field-name redaction list cannot reliably recognize.
function emit(level: 'info' | 'warn' | 'error', args: unknown[]): void {
  const strings: string[] = []
  for (const a of args) {
    if (typeof a === 'string' || typeof a === 'number' || typeof a === 'boolean') {
      strings.push(String(a))
    }
  }
  const msg = strings.join(' ')
  pinoLogger[level](msg)
}

export function safeLegacyLogArguments(args: readonly unknown[]): unknown[] {
  return args.filter(
    value => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
  )
}

/**
 * Backwards-compatible static facade over the structured logger. Existing
 * Logger.log/warn/error call sites keep working but now emit structured,
 * trace-correlated records. `enable`/`disable` toggle info/warn verbosity;
 * errors are always emitted.
 */
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class Logger {
  private static isEnabled = false

  static enable(): void {
    this.isEnabled = true
  }

  static disable(): void {
    this.isEnabled = false
  }

  static log(...args: unknown[]): void {
    if (this.isEnabled) {
      emit('info', args)
    }
  }

  static warn(...args: unknown[]): void {
    if (this.isEnabled) {
      emit('warn', args)
    }
  }

  static error(...args: unknown[]): void {
    emit('error', safeLegacyLogArguments(args))
  }
}
