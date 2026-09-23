import { authenticatedContentType } from '@bsv/sdk/auth/utils/paymentTransport'
import { Writer, toArray } from '@bsv/sdk/primitives/utils'
import { Request } from 'express'
import { stringifyBRC100 } from '@bsv/sdk'
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error']

/**
 * Helper to determine if a given message-level log should be output
 * based on the configured log level.
 */
export function isLogLevelEnabled(configuredLevel: LogLevel, messageLevel: LogLevel): boolean {
  return LOG_LEVELS.indexOf(messageLevel) >= LOG_LEVELS.indexOf(configuredLevel)
}

/**
 * Retrieves the appropriate logging method from the logger,
 * falling back to `log` if not found.
 *
 * Uses an explicit switch to avoid dynamic property access on a user-influenced
 * key, which prevents CodeQL js/unvalidated-dynamic-method-call alerts.
 */
export function getLogMethod(logger: typeof console, level: LogLevel): (...args: any[]) => void {
  try {
    let selected: unknown
    switch (level) {
      case 'debug':
        selected = typeof logger.debug === 'function' ? logger.debug : logger.log
        break
      case 'info':
        selected = typeof logger.info === 'function' ? logger.info : logger.log
        break
      case 'warn':
        selected = typeof logger.warn === 'function' ? logger.warn : logger.log
        break
      case 'error':
        selected = typeof logger.error === 'function' ? logger.error : logger.log
        break
      default:
        selected = logger.log
    }
    if (typeof selected !== 'function') return () => {}
    return (...args: any[]): void => {
      try {
        Reflect.apply(selected, logger, args)
      } catch {
        // Optional diagnostics must never change authentication behavior.
      }
    }
  } catch {
    return () => {}
  }
}

function copyDenseByteArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined
  const copy = Array.from({ length: value.length }, () => 0)
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index)
    if (
      descriptor === undefined ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
      !Number.isInteger(descriptor.value) ||
      descriptor.value < 0 ||
      descriptor.value > 255
    ) {
      return undefined
    }
    copy[index] = descriptor.value
  }
  return copy
}

function canonicalUrlEncodedBody(value: unknown): URLSearchParams | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return undefined
  const params = new URLSearchParams()
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return undefined
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      descriptor === undefined ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
      descriptor.enumerable !== true ||
      typeof descriptor.value !== 'string'
    ) {
      return undefined
    }
    params.append(key, descriptor.value)
  }
  return params
}

/**
 * Write the URL pathname and search components to the binary writer.
 */
export function writeUrlToWriter(parsedUrl: URL, writer: Writer): void {
  if (parsedUrl.pathname.length > 0) {
    const pathnameAsArray = toArray(parsedUrl.pathname)
    writer.writeVarIntNum(pathnameAsArray.length)
    writer.write(pathnameAsArray)
  } else {
    writer.writeVarIntNum(-1)
  }

  if (parsedUrl.search.length > 0) {
    const searchAsArray = toArray(parsedUrl.search)
    writer.writeVarIntNum(searchAsArray.length)
    writer.write(searchAsArray)
  } else {
    writer.writeVarIntNum(-1)
  }
}

/**
 * Collect and write signed request headers to the binary writer.
 */
export function writeRequestHeadersToWriter(req: Request, writer: Writer): void {
  const includedHeaders: Array<[string, string]> = []
  for (let [k, v] of Object.entries(req.headers)) {
    k = k.toLowerCase()
    if (
      (k.startsWith('x-bsv-') || k === 'content-type' || k === 'authorization') &&
      !k.startsWith('x-bsv-auth')
    ) {
      if (typeof v !== 'string') {
        throw new TypeError('Signed request headers must have one exact string value.')
      }
      const headerValue = k === 'content-type' ? authenticatedContentType(v) : v
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
export function writeHeaderPair(writer: Writer, key: string, value: string): void {
  const keyBytes = toArray(key, 'utf8')
  writer.writeVarIntNum(keyBytes.length)
  writer.write(keyBytes)
  const valueBytes = toArray(value, 'utf8')
  writer.writeVarIntNum(valueBytes.length)
  writer.write(valueBytes)
}

/**
 * Helper: Write body to writer
 */
export function writeBodyToWriter(
  req: Request,
  writer: Writer,
  logger?: typeof console,
  logLevel?: LogLevel
): void {
  const { body, headers } = req
  const debugLog = makeDebugLogger(logger, logLevel)

  // Inline-normalised content-type to a single string (Express may return string[]).
  // Inline narrowing rather than a helper so CodeQL's dataflow analysis can see
  // the explicit type guard (avoids js/type-confusion-through-parameter-tampering).
  const rawContentType: unknown = headers['content-type']
  let contentType = ''
  if (typeof rawContentType === 'string') {
    contentType = rawContentType.split(';', 1)[0].trim().toLowerCase()
  } else if (Array.isArray(rawContentType) && typeof rawContentType[0] === 'string') {
    contentType = rawContentType[0].split(';', 1)[0].trim().toLowerCase()
  }

  const byteArray = copyDenseByteArray(body)
  if (byteArray !== undefined) {
    writer.writeVarIntNum(byteArray.length)
    writer.write(byteArray)
    debugLog('[writeBodyToWriter] Body recognized as number[]', { length: byteArray.length })
    return
  }

  if (body instanceof Uint8Array) {
    writer.writeVarIntNum(body.length)
    writer.write(Array.from(body))
    debugLog('[writeBodyToWriter] Body recognized as Uint8Array', { length: body.length })
    return
  }

  if (contentType === 'application/json' && body !== undefined) {
    const bodyAsArray = toArray(stringifyBRC100(body), 'utf8')
    writer.writeVarIntNum(bodyAsArray.length)
    writer.write(bodyAsArray)
    debugLog('[writeBodyToWriter] Body recognized as JSON', { length: bodyAsArray.length })
    return
  }

  if (
    contentType === 'application/x-www-form-urlencoded' &&
    body !== null &&
    typeof body === 'object'
  ) {
    const params = canonicalUrlEncodedBody(body)
    if (params === undefined) {
      throw new TypeError('URL-encoded request bodies must contain only exact string fields.')
    }
    if ([...params].length === 0) {
      writer.writeVarIntNum(-1)
      debugLog('[writeBodyToWriter] No valid body to write', undefined)
      return
    }
    const parsedBody = params.toString()
    const bodyAsArray = toArray(parsedBody, 'utf8')
    writer.writeVarIntNum(bodyAsArray.length)
    writer.write(bodyAsArray)
    debugLog('[writeBodyToWriter] Body recognized as x-www-form-urlencoded', {
      length: bodyAsArray.length
    })
    return
  }

  if (contentType === 'application/x-www-form-urlencoded' && typeof body === 'string') {
    if (body.length === 0) {
      writer.writeVarIntNum(-1)
      debugLog('[writeBodyToWriter] No valid body to write', undefined)
      return
    }
    const bodyAsArray = toArray(body, 'utf8')
    writer.writeVarIntNum(bodyAsArray.length)
    writer.write(bodyAsArray)
    debugLog('[writeBodyToWriter] Body recognized as x-www-form-urlencoded', {
      length: bodyAsArray.length
    })
    return
  }

  if (contentType === 'text/plain' && typeof body === 'string' && body.length > 0) {
    const bodyAsArray = toArray(body, 'utf8')
    writer.writeVarIntNum(bodyAsArray.length)
    writer.write(bodyAsArray)
    debugLog('[writeBodyToWriter] Body recognized as text/plain', { length: bodyAsArray.length })
    return
  }

  if (body === undefined || (contentType === 'text/plain' && body === '')) {
    writer.writeVarIntNum(-1)
    debugLog('[writeBodyToWriter] No valid body to write', undefined)
    return
  }

  throw new TypeError('The parsed request body cannot be represented canonically.')
}

/**
 * Helper: Convert values passed to res.send(...) into byte arrays
 */
export function convertValueToArray(
  val: unknown,
  responseHeaders: Record<string, string>
): number[] {
  if (val === undefined || val === null) return []
  if (typeof val === 'string') {
    return toArray(val, 'utf8')
  }
  if (val instanceof Buffer) {
    return Array.from(val)
  }
  if (val instanceof Uint8Array) {
    return Array.from(val)
  }
  const byteArray = copyDenseByteArray(val)
  if (byteArray !== undefined) return byteArray
  if (typeof val === 'object' && val !== null) {
    if (!responseHeaders['content-type']) {
      responseHeaders['content-type'] = 'application/json'
    }
    return toArray(stringifyBRC100(val), 'utf8')
  }
  if (typeof val === 'number' || typeof val === 'boolean' || typeof val === 'bigint') {
    return toArray(val.toString(), 'utf8')
  }
  return []
}

/**
 * Returns a no-op or a bound debug logger depending on config.
 */
export function makeDebugLogger(
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
