import { Request } from 'express'
import { Utils } from '@bsv/sdk'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error']

/**
 * Helper to determine if a given message-level log should be output
 * based on the configured log level.
 */
export function isLogLevelEnabled (
  configuredLevel: LogLevel,
  messageLevel: LogLevel
): boolean {
  return LOG_LEVELS.indexOf(messageLevel) >= LOG_LEVELS.indexOf(configuredLevel)
}

/**
 * Retrieves the appropriate logging method from the logger,
 * falling back to `log` if not found.
 *
 * Uses an explicit switch to avoid dynamic property access on a user-influenced
 * key, which prevents CodeQL js/unvalidated-dynamic-method-call alerts.
 */
export function getLogMethod (
  logger: typeof console,
  level: LogLevel
): (...args: any[]) => void {
  switch (level) {
    case 'debug': return (typeof logger.debug === 'function' ? logger.debug : logger.log).bind(logger)
    case 'info': return (typeof logger.info === 'function' ? logger.info : logger.log).bind(logger)
    case 'warn': return (typeof logger.warn === 'function' ? logger.warn : logger.log).bind(logger)
    case 'error': return (typeof logger.error === 'function' ? logger.error : logger.log).bind(logger)
    default: return logger.log.bind(logger)
  }
}

/**
 * Write the URL pathname and search components to the binary writer.
 */
export function writeUrlToWriter (parsedUrl: URL, writer: Utils.Writer): void {
  if (parsedUrl.pathname.length > 0) {
    const pathnameAsArray = Utils.toArray(parsedUrl.pathname)
    writer.writeVarIntNum(pathnameAsArray.length)
    writer.write(pathnameAsArray)
  } else {
    writer.writeVarIntNum(-1)
  }

  if (parsedUrl.search.length > 0) {
    const searchAsArray = Utils.toArray(parsedUrl.search)
    writer.writeVarIntNum(searchAsArray.length)
    writer.write(searchAsArray)
  } else {
    writer.writeVarIntNum(-1)
  }
}

/**
 * Collect and write signed request headers to the binary writer.
 */
export function writeRequestHeadersToWriter (req: Request, writer: Utils.Writer): void {
  const includedHeaders: Array<[string, string]> = []
  for (let [k, v] of Object.entries(req.headers)) {
    k = k.toLowerCase()
    // Normalise to a single string — Express may return string[] when a header
    // is repeated (e.g. `Set-Cookie`).  Take the first value to avoid
    // type-confusion (CodeQL js/type-confusion-through-parameter-tampering).
    const vStr: string = Array.isArray(v) ? v[0] : (typeof v === 'string' ? v : '')
    let headerValue = vStr
    if (k === 'content-type') {
      headerValue = vStr.split(';')[0].trim()
    }
    if (
      (k.startsWith('x-bsv-') || k === 'content-type' || k === 'authorization') &&
      !k.startsWith('x-bsv-auth')
    ) {
      includedHeaders.push([k, headerValue])
    }
  }
  includedHeaders.sort(([keyA], [keyB]) => keyA.localeCompare(keyB))

  writer.writeVarIntNum(includedHeaders.length)
  for (const [headerKey, headerValue] of includedHeaders) {
    writeHeaderPair(writer, headerKey, headerValue)
  }
}

/**
 * Write a header pair (key + value) to the binary writer.
 */
export function writeHeaderPair (writer: Utils.Writer, key: string, value: string): void {
  const keyBytes = Utils.toArray(key, 'utf8')
  writer.writeVarIntNum(keyBytes.length)
  writer.write(keyBytes)
  const valueBytes = Utils.toArray(value, 'utf8')
  writer.writeVarIntNum(valueBytes.length)
  writer.write(valueBytes)
}

/**
 * Helper: Write body to writer
 */
export function writeBodyToWriter (
  req: Request,
  writer: Utils.Writer,
  logger?: typeof console,
  logLevel?: LogLevel
): void {
  const { body, headers } = req
  const debugLog = makeDebugLogger(logger, logLevel)

  // Normalise a header to a single string — Express may return string[] when a
  // header is repeated.  Take the first value to avoid type-confusion (CodeQL
  // js/type-confusion-through-parameter-tampering).
  const getHeader = (name: string): string => {
    const v = headers[name]
    if (Array.isArray(v)) return v[0] ?? ''
    return typeof v === 'string' ? v : ''
  }
  const contentType = getHeader('content-type')

  if (Array.isArray(body) && body.every((item) => typeof item === 'number')) {
    writer.writeVarIntNum(body.length)
    writer.write(body)
    debugLog('[writeBodyToWriter] Body recognized as number[]', { length: body.length })
    return
  }

  if (body instanceof Uint8Array) {
    writer.writeVarIntNum(body.length)
    writer.write(Array.from(body))
    debugLog('[writeBodyToWriter] Body recognized as Uint8Array', { length: body.length })
    return
  }

  if (contentType === 'application/json' && typeof body === 'object') {
    const bodyAsArray = Utils.toArray(JSON.stringify(body), 'utf8')
    writer.writeVarIntNum(bodyAsArray.length)
    writer.write(bodyAsArray)
    debugLog('[writeBodyToWriter] Body recognized as JSON', { body })
    return
  }

  if (
    contentType === 'application/x-www-form-urlencoded' &&
    body &&
    Object.keys(body).length > 0
  ) {
    const parsedBody = new URLSearchParams(body).toString()
    const bodyAsArray = Utils.toArray(parsedBody, 'utf8')
    writer.writeVarIntNum(bodyAsArray.length)
    writer.write(bodyAsArray)
    debugLog('[writeBodyToWriter] Body recognized as x-www-form-urlencoded', { parsedBody })
    return
  }

  if (contentType === 'text/plain' && typeof body === 'string' && body.length > 0) {
    const bodyAsArray = Utils.toArray(body, 'utf8')
    writer.writeVarIntNum(bodyAsArray.length)
    writer.write(bodyAsArray)
    debugLog('[writeBodyToWriter] Body recognized as text/plain', { body })
    return
  }

  // No valid body
  writer.writeVarIntNum(-1)
  debugLog('[writeBodyToWriter] No valid body to write', undefined)
}

/**
 * Helper: Convert values passed to res.send(...) into byte arrays
 */
export function convertValueToArray (val: any, responseHeaders: Record<string, any>): number[] {
  if (typeof val === 'string') {
    return Utils.toArray(val, 'utf8')
  }
  if (val instanceof Buffer) {
    return Array.from(val)
  }
  if (typeof val === 'object' && val !== null) {
    if (!responseHeaders['content-type']) {
      responseHeaders['content-type'] = 'application/json'
    }
    return Utils.toArray(JSON.stringify(val), 'utf8')
  }
  if (typeof val === 'number') {
    return Utils.toArray(val.toString(), 'utf8')
  }
  return Utils.toArray(String(val), 'utf8')
}

/**
 * Returns a no-op or a bound debug logger depending on config.
 */
export function makeDebugLogger (
  logger?: typeof console,
  logLevel?: LogLevel
): (msg: string, data: any) => void {
  if (logger && logLevel && isLogLevelEnabled(logLevel, 'debug')) {
    const fn = getLogMethod(logger, 'debug')
    return (msg: string, data: any) => {
      if (data !== undefined) {
        fn(msg, data)
      } else {
        fn(msg)
      }
    }
  }
  return () => {}
}
