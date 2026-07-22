import pino from 'pino'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
// Resolve package.json relative to this module (source and compiled layouts)
// instead of process.cwd() so embedded hosts can import us from any cwd.
let pkg: { name: string; version: string } = {
  name: '@bsv/messagebox-server',
  version: '0.0.0'
}
for (const candidate of ['../../package.json', '../../../package.json']) {
  try {
    pkg = require(candidate) as { name: string; version: string }
    break
  } catch {
    // try next layout
  }
}

// Structured pino logger. @opentelemetry/instrumentation-pino (loaded by
// telemetry.ts) injects trace_id/span_id into every record, and records are
// shipped to the OTLP logs endpoint. Stable base fields: service, env.
const pinoLogger = pino({
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

// Export the raw pino logger for call sites that want structured fields:
//   log.info({ operation: 'send', room_id }, 'message delivered')
export const log = pinoLogger

// Split variadic args into a message string + structured detail object so legacy
// Logger.log('text', value) calls still produce useful structured records.
function emit(level: 'info' | 'warn' | 'error', args: unknown[]): void {
  const strings: string[] = []
  const details: unknown[] = []
  for (const a of args) {
    if (typeof a === 'string' || typeof a === 'number' || typeof a === 'boolean') {
      strings.push(String(a))
    } else {
      details.push(a)
    }
  }
  const msg = strings.join(' ')
  if (details.length > 0) {
    pinoLogger[level]({ detail: details.length === 1 ? details[0] : details }, msg)
  } else {
    pinoLogger[level](msg)
  }
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
    emit('error', args)
  }
}
