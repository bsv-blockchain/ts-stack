/**
 * Framework-agnostic request/response types for server handlers.
 * Avoids importing 'next/server' so the library has no Next.js build dependency.
 */

import { stringifyBRC100 } from '@bsv/sdk'
import { snapshotPlainDataRecord } from '../core/certificate-validation'

const DEFAULT_MAX_REQUEST_BYTES = 64 * 1024 * 1024
const MAX_CONFIGURED_REQUEST_BYTES = 256 * 1024 * 1024

export interface HandlerLimits {
  /** Maximum decoded JSON request bytes. Defaults to 64 MiB; maximum 256 MiB. */
  maxRequestBytes?: number
}

export interface HandlerRequest {
  url: string
  method: string
  headers?: Headers
  json: () => Promise<any>
}

export interface HandlerResponse {
  status: number
  body: any
}

export interface RouteHandler {
  GET?: (req: HandlerRequest) => Promise<HandlerResponse>
  POST?: (req: HandlerRequest) => Promise<HandlerResponse>
}

/** Extract search params from a URL string. */
export function getSearchParams(url: string): URLSearchParams {
  try {
    return new URL(url).searchParams
  } catch {
    // Fallback for relative URLs
    const qIndex = url.indexOf('?')
    return new URLSearchParams(qIndex >= 0 ? url.substring(qIndex + 1) : '')
  }
}

/** Create a JSON response object. */
export function jsonResponse(data: any, status = 200): HandlerResponse {
  return { status, body: data }
}

function requestMember(request: unknown, key: string): unknown {
  if (request == null || (typeof request !== 'object' && typeof request !== 'function')) {
    return undefined
  }
  try {
    const own = Object.getOwnPropertyDescriptor(request, key)
    if (own != null) {
      return Object.getOwnPropertyDescriptor(own, 'value') == null ? undefined : own.value
    }
    let prototype = Object.getPrototypeOf(request)
    while (prototype != null && prototype !== Object.prototype) {
      if (Object.getOwnPropertyDescriptor(prototype, key) != null) {
        return Reflect.get(request, key)
      }
      prototype = Object.getPrototypeOf(prototype)
    }
  } catch {
    return undefined
  }
  return undefined
}

function requestLimit(limits?: HandlerLimits): number {
  const record =
    limits == null
      ? (Object.create(null) as Record<string, unknown>)
      : snapshotPlainDataRecord(limits)
  if (record == null) throw new TypeError('Invalid handler limits')
  const value = record.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_CONFIGURED_REQUEST_BYTES
  ) {
    throw new TypeError(
      `maxRequestBytes must be a safe integer between 1 and ${MAX_CONFIGURED_REQUEST_BYTES}`
    )
  }
  return value
}

async function readBoundedJson(
  req: any,
  maximum: number,
  url: string,
  parseJson?: (text: string, url: string) => unknown
): Promise<unknown> {
  const headers = requestMember(req, 'headers')
  const declared = headers instanceof Headers ? headers.get('content-length') : null
  if (declared != null && (!/^(0|[1-9]\d*)$/.test(declared) || Number(declared) > maximum)) {
    throw new RangeError('Request body exceeds the configured limit')
  }

  const body = requestMember(req, 'body') as ReadableStream<Uint8Array> | null | undefined
  if (body == null) {
    const json = requestMember(req, 'json')
    if (typeof json !== 'function') throw new TypeError('Request JSON reader is unavailable')
    return await Reflect.apply(json, req, [])
  }

  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: parseJson !== undefined })
  let total = 0
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maximum) {
        await reader.cancel()
        throw new RangeError('Request body exceeds the configured limit')
      }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
  } finally {
    reader.releaseLock()
  }

  return parseJson == null ? (JSON.parse(text) as unknown) : parseJson(text, url)
}

/**
 * Wrap core handlers into Next.js App Router compatible { GET, POST }.
 * Uses the Web-standard Response API (available in Next.js, Deno, Bun, etc.)
 * — no 'next/server' import needed.
 */
export function toNextHandlers(
  handler: RouteHandler,
  limits?: HandlerLimits,
  parseJson?: (text: string, url: string) => unknown
): {
  GET?: (req: any) => Promise<any>
  POST?: (req: any) => Promise<any>
} {
  const handlerRecord = snapshotPlainDataRecord(handler)
  if (handlerRecord == null) throw new TypeError('Invalid route handler table')
  for (const method of ['GET', 'POST'] as const) {
    if (handlerRecord[method] != null && typeof handlerRecord[method] !== 'function') {
      throw new TypeError(`Invalid ${method} route handler`)
    }
  }
  const maxRequestBytes = requestLimit(limits)
  const wrapHandler = (method: 'GET' | 'POST'): ((req: any) => Promise<any>) | undefined => {
    const coreFn = handlerRecord[method] as RouteHandler[typeof method]
    if (coreFn == null) return undefined

    return async (req: any): Promise<any> => {
      let jsonPromise: Promise<unknown> | undefined
      const directUrl = requestMember(req, 'url')
      const nextUrl = requestMember(req, 'nextUrl')
      const headers = requestMember(req, 'headers')
      const ownedRequest = Object.assign(Object.create(null) as HandlerRequest, {
        url: typeof directUrl === 'string' ? directUrl : nextUrl == null ? '' : String(nextUrl),
        method,
        ...(headers instanceof Headers ? { headers } : {}),
        json: async () => {
          jsonPromise ??= readBoundedJson(req, maxRequestBytes, ownedRequest.url, parseJson)
          return await jsonPromise
        }
      })
      const result = await coreFn(ownedRequest)

      // Use Web-standard Response (works in Next.js, Deno, Bun, Workers)
      return new Response(stringifyBRC100(result.body), {
        status: result.status,
        headers: { 'Content-Type': 'application/json' }
      })
    }
  }

  return Object.assign(Object.create(null), {
    ...(handlerRecord.GET == null ? {} : { GET: wrapHandler('GET') }),
    ...(handlerRecord.POST == null ? {} : { POST: wrapHandler('POST') })
  })
}
